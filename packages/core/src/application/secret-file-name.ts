/**
 * The secret-looking file NAME rule (ADR-0019 "never read secrets", ADR-0022 workspace policy, ADR-0099 D6 "a secret
 * token or filename on any target fails the whole set"). Single source of truth: the local workspace adapter's
 * `DEFAULT_WORKSPACE_POLICY.isSecret` (read/list/write refusal) and the conversational code-change target collection
 * (QA-V2-CL-02 — a secret-named target is refused by NAME with truthful copy, never reported as "not found") both use
 * it. Name-only and pure: it never touches the filesystem, so applying it reveals nothing about whether a file exists.
 */

/**
 * Conventional credential-file names the substring rule below does not already cover (it already catches
 * `credentials.json`, `.git-credentials`, `*.key`, `*.keystore`, `secrets.*`): service-account JSON, PEM / PKCS#12 /
 * Java keystores, SSH private keys, and package-manager / network auth files.
 */
const CREDENTIAL_FILE_NAME =
  /(service[-_]?account.*\.json$|\.(pem|p12|pfx|jks)$|^id_(rsa|dsa|ecdsa|ed25519)|^\.(npmrc|pypirc|netrc)$)/i;

/** Whether a file's BASENAME looks like an env / secret / credential file — never read, listed, sent or written. */
export function isSecretLookingFileName(name: string): boolean {
  return (
    /\.env(\.|$)/i.test(name) ||
    /(secret|token|key|credential|password)/i.test(name) ||
    CREDENTIAL_FILE_NAME.test(name)
  );
}
