/**
 * Chat response policy (ADR-0098) — application sub-barrel.
 *
 * The root application barrel re-exports this folder (SEAM-1, ADR-0096 D8); new modules are exported here only.
 */
export {
  CHAT_CAPABILITY_HONESTY_RULE,
  CHAT_FORMATTING_RULE,
  CHAT_INJECTION_RULE,
  CHAT_NO_UNREQUESTED_TRANSLATION_RULE,
  ENGLISH_LETTER_SHARE_THRESHOLD,
  GENERAL_CHAT_POLICY_RULES,
  KOREAN_LETTER_SHARE_THRESHOLD,
  detectReplyLanguage,
  hasExplicitLanguageRequest,
  renderGeneralChatPolicyRules,
  replyLanguageFact,
} from './chat-response-policy';
export type { ReplyLanguage } from './chat-response-policy';
