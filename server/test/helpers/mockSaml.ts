import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

/** Keys + a signed-assertion factory standing in for a SAML identity provider. */
export class MockSaml {
  readonly entityId = 'https://idp.example/entity';
  readonly entryPoint = 'https://idp.example/sso';
  readonly key: string;
  readonly cert: string;
  readonly otherKey: string;

  constructor() {
    const dir = mkdtempSync(path.join(tmpdir(), 'wobs-saml-'));
    const gen = (name: string) => {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`), '-subj', `/CN=${name}`, '-days', '2'], { stdio: 'ignore' });
      return [readFileSync(path.join(dir, `${name}.key`), 'utf8'), readFileSync(path.join(dir, `${name}.crt`), 'utf8')] as const;
    };
    [this.key, this.cert] = gen('idp');
    [this.otherKey] = gen('evil');
  }

  /** ID of the AuthnRequest in a redirect-binding URL. */
  requestId(redirectUrl: string): string {
    const saml = new URL(redirectUrl).searchParams.get('SAMLRequest')!;
    const xml = inflateRawSync(Buffer.from(saml, 'base64')).toString('utf8');
    return /ID="([^"]+)"/.exec(xml)![1];
  }

  response(o: {
    inResponseTo?: string;
    destination: string;
    audience: string;
    nameId: string;
    attrs?: Record<string, string[]>;
    sign?: 'ok' | 'none' | 'wrong-key';
    issuer?: string;
    validForSeconds?: number;
  }): string {
    const now = new Date();
    const iso = (d: Date) => d.toISOString();
    const until = new Date(now.getTime() + (o.validForSeconds ?? 300) * 1000);
    const issuer = o.issuer ?? this.entityId;
    const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
    const attrs = Object.entries(o.attrs ?? {})
      .map(([k, v]) => `<saml:Attribute Name="${k}">${v.map((x) => `<saml:AttributeValue xsi:type="xs:string">${x}</saml:AttributeValue>`).join('')}</saml:Attribute>`)
      .join('');
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="_resp${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(now)}" Destination="${o.destination}"${irt}>` +
      `<saml:Issuer>${issuer}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      `<saml:Assertion ID="_as${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${issuer}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(until)}" Recipient="${o.destination}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 5000))}" NotOnOrAfter="${iso(until)}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_sess1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
      `</saml:Assertion></samlp:Response>`;
    if (o.sign === 'none') return Buffer.from(xml).toString('base64');
    const sig = new SignedXml({
      privateKey: o.sign === 'wrong-key' ? this.otherKey : this.key,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    return Buffer.from(sig.getSignedXml()).toString('base64');
  }
}
