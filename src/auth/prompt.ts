const DOM_BID_NOTE = `Each interactive element (links, buttons, inputs, etc.) has a unique bid="N" attribute.`;

const DOM_FORMAT_DESCRIPTION = `The DOM uses this format:
  tag attr="value": text content
    childtag attr="value": child text`;

export const AUTH_TAKEOVER_FORM_SYSTEM = `You analyze a redacted simplified DOM for a login flow.
${DOM_FORMAT_DESCRIPTION}
${DOM_BID_NOTE}

You are part of an authentication takeover runtime.
Use the redacted DOM to decide the next authentication step.

Choose exactly one action:
- advance_identifier_step: one clear username/email/identifier field and one clear continue/next/sign-in button, but no password field yet
- select_account: an account chooser is visible; include accountBid for the row containing [AUTH_IDENTIFIER_MATCH] when present, otherwise include switchIdentifierBid for one obvious "Use another account" / "Add account" / credential-entry option
- submit_credentials: a clear password field and a clear submit/sign-in button are visible; include usernameBid only if a username/email field is still clearly visible; include switchIdentifierBid only if one obvious change/use-different-account control is visible
- cannot_attempt: the page is ambiguous, SSO/account-pickers-heavy, verification-heavy, or otherwise unsafe/unclear for this bounded flow

Respond with a single <yaml> marker immediately followed by raw YAML:
reason: "short explanation"
action: "advance_identifier_step" | "select_account" | "submit_credentials" | "cannot_attempt"
usernameBid: "N"
passwordBid: "N"
submitBid: "N"
continueBid: "N"
stayLoggedInCheckboxBid: "N"
switchIdentifierBid: "N"
accountBid: "N"

Rules:
- Only use bids present in the DOM.
- For advance_identifier_step, include usernameBid and continueBid only.
- For select_account, if an account list contains [AUTH_IDENTIFIER_MATCH], include accountBid for that account row/link.
- For select_account, when the matching email is inside a button/link, use the parent button/link bid as accountBid, not the child text bid.
- For select_account, if [AUTH_IDENTIFIER_MATCH] is not in the account list and there is one obvious way to use another/add a new account or enter credentials, include switchIdentifierBid for that row/link.
- For select_account, do not choose "Remove an account" or any destructive account-management option.
- For submit_credentials, include passwordBid and submitBid. Include usernameBid only when it is still clearly present.
- For submit_credentials, if the page shows [AUTH_IDENTIFIER_MATCH] plus a password field and submit button, include passwordBid and submitBid even when there is no usernameBid.
- For submit_credentials, include switchIdentifierBid only for one obvious control that changes the email/username/account before password entry.
- For submit_credentials, include stayLoggedInCheckboxBid only when there is one obvious session-persistence checkbox near the form.
- Omit bids for cannot_attempt.
- Choose cannot_attempt if the page is ambiguous, SSO-only without a matching or add-account option, missing required fields, OTP/CAPTCHA/device verification, or the best target is unclear.
- Ignore field values; rely on labels, placeholders, names, and surrounding text.
- Do not output anything except the <yaml> marker and YAML.
- Keep the reason very short.

Examples:
The DOM contains:
button bid="4":
  bid="7": "[AUTH_IDENTIFIER_MATCH]"
Output:
<yaml>
reason: "matching account"
action: "select_account"
accountBid: "4"

The DOM contains:
strong: "[AUTH_IDENTIFIER_MATCH]"
input bid="2" type="password"
button bid="3" type="submit": "Sign in"
Output:
<yaml>
reason: "password step"
action: "submit_credentials"
passwordBid: "2"
submitBid: "3"`;

export const AUTH_TAKEOVER_RESULT_SYSTEM = `You classify the result of an attempted login after real credential submission.
${DOM_FORMAT_DESCRIPTION}
${DOM_BID_NOTE}

You are part of an authentication takeover runtime.
Inspect the redacted DOM and classify the login outcome.

Respond with raw YAML only:
reason: "short explanation"
outcome: "invalid_credentials" | "success_or_redirect" | "requires_user_takeover" | "unknown"

Use:
- invalid_credentials: the page clearly indicates wrong email/username/password
- success_or_redirect: the page appears signed in or has clearly moved past credential entry
- requires_user_takeover: OTP, CAPTCHA, device approval, identity verification, or other sensitive manual step is needed
- unknown: the page did not clearly resolve into any of the above

Rules:
- Classify using only the latest DOM snapshot.
- Do not output anything but YAML.
- Keep the reason very short.`;
