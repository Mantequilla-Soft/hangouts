export function useHiveAvatar(username: string, size: 'small' | 'medium' | 'large' = 'medium'): string {
  return `https://images.hive.blog/u/${username}/avatar/${size}`;
}
