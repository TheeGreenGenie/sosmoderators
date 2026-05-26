import type { SpamScore, SubConfig } from '../redis/schema.js';

export const SIGNAL_COPY: Record<string, { label: string; fix: string }> = {
  title_duplicate: {
    label: 'Very similar title posted recently',
    fix: 'Rephrase your title significantly or comment on the existing post instead.',
  },
  selftext_duplicate: {
    label: 'Body text nearly identical to a recent post',
    fix: 'Add original content or perspective to differentiate your post.',
  },
  domain_banned: {
    label: 'Link from a restricted domain',
    fix: 'Use an approved source or share the information directly in the post body.',
  },
  banned_keyword: {
    label: 'Contains a phrase on the spam list',
    fix: 'Remove or rephrase the flagged term.',
  },
  url_in_title: {
    label: 'URL in post title',
    fix: 'Move the link to the post body.',
  },
  high_url_density: {
    label: 'Too many links for the amount of text',
    fix: 'Reduce the number of links and add more original context.',
  },
  excessive_caps: {
    label: '3+ words in ALL CAPS',
    fix: 'Use normal capitalization in your title.',
  },
  excessive_punctuation: {
    label: '3+ consecutive ! or ? marks',
    fix: 'Use standard punctuation.',
  },
  very_new_account: {
    label: 'Account is very new',
    fix: 'This flag clears automatically as you participate in the community.',
  },
};

export function signalLabel(signal: string): string {
  return SIGNAL_COPY[signal]?.label ?? signal.replace(/_/g, ' ');
}

export function signalFix(signal: string): string {
  return SIGNAL_COPY[signal]?.fix ?? 'Edit the post to better match the subreddit rules.';
}

export function formatWhyRemovedPM(
  spamScore: SpamScore,
  config: SubConfig,
  author: string,
  title: string,
  subName: string,
  includeRecheck = true,
): string {
  const signalLines = spamScore.signals.length > 0
    ? spamScore.signals.map((signal) => `  - ${signalLabel(signal)} (${signal})`).join('\n')
    : '  - No specific signal was recorded.';

  const primaryFix = spamScore.signals.length > 0
    ? signalFix(spamScore.signals[0] ?? '')
    : 'Review the subreddit rules and edit the post before asking for a recheck.';

  return [
    `Hi u/${author} - your post "${title}" was held for review on r/${subName}.`,
    '',
    'What triggered it:',
    signalLines,
    `  Total spam score: ${spamScore.score.toFixed(2)} (flag threshold: ${config.spamDetection.autoFlagThreshold.toFixed(2)})`,
    '',
    'To get it approved:',
    `  ${primaryFix}`,
    '',
    ...(includeRecheck ? [
      'After making your edit, reply to this message with: !recheck',
      'SubGuardian will re-run the check automatically.',
    ] : [
      'Unfortunately this cannot be fixed by editing — you may need to repost with a corrected title.',
    ]),
    '',
    '*Automated message from SubGuardian. If you think this is wrong, contact the mods.*',
  ].join('\n');
}
