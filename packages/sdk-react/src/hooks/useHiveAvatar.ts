const GUEST_DEFAULT = 'snapie';

export function useHiveAvatar(username: string, size: 'small' | 'medium' | 'large' = 'medium'): string {
  const account = username.startsWith('guest-') ? GUEST_DEFAULT : username;
  return `https://images.hive.blog/u/${account}/avatar/${size}`;
}
