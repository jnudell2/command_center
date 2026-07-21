const JAKE_EMAILS = new Set([
  "jake.nudell@serentcapital.com",
]);

export function normalizedSubject(value) {
  return String(value || "").toLowerCase().replace(/^\s*((re|fw|fwd):\s*)+/i, "").replace(/\s+/g, " ").trim();
}

function recipientAddress(recipient) {
  return String(recipient?.emailAddress?.address || recipient?.address || recipient?.email || "").toLowerCase();
}

function newestMessageText(value) {
  return String(value || "").split(/\r?\n(?:on .{0,160}wrote:|from:|_{4,})/i, 1)[0];
}

export function isDirectlyAddressedToJake(message) {
  const directRecipient = (Array.isArray(message?.toRecipients) ? message.toRecipients : [])
    .some((recipient) => JAKE_EMAILS.has(recipientAddress(recipient)));
  if (directRecipient) return true;

  const currentText = newestMessageText(message?.bodyPreview);
  return /(?:^|\r?\n)\s*(?:external\s*)?(?:hi|hey|thanks|thank you)\s*,?\s+jake\b/i.test(currentText)
    || /(?:^|\r?\n)\s*jake\s*[,!:;-]/i.test(currentText)
    || /\b(?:glad|happy|excited)\s+to\s+have\s+you(?:\s+[^\r\n,.!?]+)?\s*,?\s+jake\b/i.test(currentText);
}

export function isLikelyAutomatedMail(message) {
  const sender = message?.from?.emailAddress || {};
  const text = `${message?.subject || ""}\n${message?.bodyPreview || ""}\n${sender.name || ""}\n${sender.address || ""}`.toLowerCase();
  return /newsletter|unsubscribe|no[- ]?reply|notification|alert|digest|calendar|invitation|accepted:|declined:|out of office|automatic reply|do not reply|webinar|survey|event feedback|challenge results|sent a message in teams|see how .* delivers|demo session|placeholder:|gold star|livestream|free registration/.test(text);
}
