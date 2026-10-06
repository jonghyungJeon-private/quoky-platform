import { describe, expect, it } from 'vitest';
import { isSecretLookingFileName } from './secret-file-name';

describe('isSecretLookingFileName (ADR-0019/0022, ADR-0099 D6, QA-V2-CL-02)', () => {
  it.each([
    'hardsecret.js', '.env', '.env.local', 'prod.env', 'api-token.ts', 'apikey.json', 'credentials.json',
    'password.txt', 'service-account-prod.json', 'server.pem', 'id_ed25519', '.npmrc', 'SECRETS.yaml',
  ])('%s is secret-looking', (name) => {
    expect(isSecretLookingFileName(name)).toBe(true);
  });

  it.each(['test.js', 'greet.js', 'package.json', 'README.md', 'config.js', 'environment.ts'])('%s is ordinary', (name) => {
    expect(isSecretLookingFileName(name)).toBe(false);
  });
});
