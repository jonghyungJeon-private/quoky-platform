/**
 * Deterministic credential-declaration detector shared by the durable-memory write gate and the
 * read-time recall filter. Conservative on purpose: it refuses only when a credential keyword is
 * being assigned a value ("비밀번호는 x", "password: x", "my pin is 1234") or when the text carries
 * token-shaped material, so harmless facts about passwords/tokens in general still pass.
 */

export const CREDENTIAL_REJECTION_REASON = 'candidate contains credential or authentication material';

const KO_KEYWORD =
  '(?:비밀\\s?번호|패스워드|비번|인증\\s?번호|OTP|PIN|핀\\s?번호|카드\\s?번호|계좌\\s?비밀번호|API\\s?키|액세스\\s?키|토큰|시크릿|비밀\\s?키|개인\\s?키|암호)';
const EN_KEYWORD =
  '(?:password|passwd|pwd|passcode|pass\\s?phrase|pin(?:\\s?(?:code|number))?|otp|card\\s?number|api[\\s_-]?key|access[\\s_-]?(?:key|token)|auth[\\s_-]?token|token|secret(?:[\\s_-]?key)?|private[\\s_-]?key)';

const KOREAN_ASSIGNMENT = new RegExp(`${KO_KEYWORD}\\s*(?:[:=]|(?:은|는|이|가)(?![가-힣]))\\s*\\S+`, 'iu');
const ENGLISH_ASSIGNMENT = new RegExp(
  `\\b${EN_KEYWORD}(?:\\s+(?:is|are|was|will\\s+be)\\b|\\s*[:=])\\s*\\S+`,
  'iu',
);
const TOKEN_SHAPED = new RegExp(
  [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    '\\bsk-[A-Za-z0-9_-]{16,}',
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    '\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}',
    '\\b(?:\\d[ -]?){15}\\d\\b',
  ].join('|'),
  'u',
);

/** True when `text` declares a credential value or carries token-shaped secret material. */
export function containsCredentialMaterial(text: string): boolean {
  return KOREAN_ASSIGNMENT.test(text) || ENGLISH_ASSIGNMENT.test(text) || TOKEN_SHAPED.test(text);
}
