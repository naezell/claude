export function mailSettings(env) {
  const key = env.get('ADVISORY_RESEND_KEY'), from = env.get('ADVISORY_MAIL_FROM');
  return key && from ? { key, from } : null;
}

export async function sendAdvisoryMail(mail, { to, subject, text, replyTo, id }, fetchFn = fetch) {
  const response = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + mail.key, 'Content-Type': 'application/json', 'Idempotency-Key': id },
    body: JSON.stringify({ from: mail.from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error('The email provider could not send this message.');
}
