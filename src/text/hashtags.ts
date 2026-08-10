export function extractHashtags(content: string): { cleanContent: string; hashtags: string[] } {
  const hashtagPattern = /#\w+(?:-\w+)*/g;
  const hashtags = (content.match(hashtagPattern) ?? []).map(t => t.slice(1).toLowerCase());
  const cleanContent = content.replace(hashtagPattern, '').replace(/\s+/g, ' ').trim();
  return { cleanContent, hashtags };
}
