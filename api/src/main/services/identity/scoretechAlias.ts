export function scoretechAlias(email: string) {
  const prefix = email.split('@', 1)[0].toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 30);
  return prefix.length >= 3 ? prefix : ['scoretech', prefix].filter(Boolean).join('-');
}
