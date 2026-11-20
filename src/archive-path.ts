export function safeArchivePath(path: string): boolean {
  return !!path && path.length <= 1024 && !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}
