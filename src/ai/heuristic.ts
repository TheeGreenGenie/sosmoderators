import type { AIProvider, AIAnalysisResult, UserHistory, ContentContext } from './interface.js';
import { hasBadFaithPattern, sincerity, PATTERNS } from '../utils/regex.js';
import { computeToxicityScore } from '../scoring/toxicityScore.js';

// ─── Flair Detector ────────────────────────────────────────────────────────────

type ContentCategory =
  | 'humor'
  | 'discussion'
  | 'gaming'
  | 'news'
  | 'science'
  | 'music'
  | 'animals'
  | 'entertainment'
  | 'visual'
  | 'technology'
  | 'finance'
  | 'health'
  | 'politics'
  | 'hobbies'
  | 'community';

interface CategoryDef {
  strong: string[];
  medium: string[];
  weak: string[];
  bigrams: string[];          // two-word phrases that are strong signals
  patterns: RegExp[];
  boosters: RegExp[];
  negations: RegExp[];
  flairKeywords: string[];    // words in a flair name that map to this category
}

const CATEGORIES: Record<ContentCategory, CategoryDef> = {
  humor: {
    strong: ['lol', 'lmao', 'rofl', 'meme', 'joke', 'troll', 'cope', 'ratio', 'kek', 'cringe', 'sus', 'based', 'bruh', 'xd', 'haha', 'yikes', 'oof', 'sheesh'],
    medium: ['funny', 'hilarious', 'dead', 'dying', 'ironic', 'sarcastic', 'parody', 'satire', 'prank', 'cursed', 'chaotic'],
    weak: ['fun', 'laugh', 'humor', 'silly', 'weird', 'strange'],
    bigrams: ['cant stop', 'not real', 'this is fine', 'only in', 'peak comedy', 'living rent free'],
    patterns: [
      /lmao|rofl|kekw/i,
      /\b(so|this is|that was)\s+(funny|hilarious|cursed|based)\b/i,
      /imagine (being|thinking|doing)/i,
    ],
    boosters: [/💀|😭|🤣|😂/u, /vibes|energy|mood/i],
    negations: [/not funny|dead serious|serious question/i],
    flairKeywords: ['humor', 'meme', 'memes', 'funny', 'joke', 'shitpost', 'satire', 'comedy', 'lol'],
  },

  discussion: {
    strong: ['thoughts', 'opinion', 'discuss', 'debate', 'rant', 'vent', 'unpopular', 'controversial', 'eli5', 'change my mind', 'hot take', 'anyone else'],
    medium: ['experience', 'perspective', 'take', 'viewpoint', 'curious', 'wondering', 'genuinely', 'honestly', 'feel like', 'would you'],
    weak: ['idk', 'imo', 'tbh', 'ngl', 'maybe', 'perhaps'],
    bigrams: ['what do you', 'do you think', 'hot take', 'unpopular opinion', 'change my mind', 'am i wrong', 'anyone else feel', 'let me know', 'what are your'],
    patterns: [
      /\?$/,
      /\b(what|how|why|when|who|does|is|are|should|would|could|can)\b.{0,60}\?/i,
      /thoughts on|opinions on|experiences with|anyone else/i,
      /\b(agree|disagree|debate|discuss)\b/i,
    ],
    boosters: [/anyone|here|guys|community|subreddit/i, /share|weigh in|chime in/i],
    negations: [],
    flairKeywords: ['discussion', 'discuss', 'debate', 'question', 'opinion', 'rant', 'vent', 'ask', 'q&a', 'ama', 'meta', 'weekly', 'daily', 'monthly', 'thread'],
  },

  gaming: {
    strong: ['game', 'gaming', 'gamer', 'fps', 'rpg', 'mmorpg', 'moba', 'battle royale', 'speedrun', 'nerf', 'buff', 'loot', 'grind', 'boss', 'raid', 'pvp', 'pve', 'esports'],
    medium: ['steam', 'twitch', 'playstation', 'xbox', 'nintendo', 'pc gaming', 'console', 'controller', 'multiplayer', 'singleplayer', 'dlc', 'patch', 'update', 'season', 'ranked', 'winrate', 'meta build', 'loadout', 'achievement'],
    weak: ['level', 'quest', 'character', 'spawn', 'map', 'server'],
    bigrams: ['just beat', 'finally finished', 'anyone playing', 'tips for', 'best build', 'early access', 'game pass', 'new season'],
    patterns: [
      /\b(playing|beat|stuck on|grinding|farming)\s+\w+/i,
      /\b(k\/d|kd ratio|winrate|kill streak)\b/i,
      /patch notes|hotfix|season \d+/i,
    ],
    boosters: [/🎮|🕹️/u, /just got|finally|clutch|tryhard/i],
    negations: [],
    flairKeywords: ['gaming', 'game', 'games', 'esports', 'stream', 'playthrough', 'clip', 'highlight'],
  },

  news: {
    // Political figures removed — they live in politics. News focuses on event-reporting language.
    strong: ['breaking', 'announced', 'sources say', 'according to', 'confirmed', 'leaked', 'exclusive', 'developing', 'incident', 'explosion', 'earthquake', 'arrest', 'verdict', 'sentenced'],
    medium: ['report', 'investigation', 'officials', 'statement', 'press release', 'spokesperson', 'crisis', 'emergency', 'disaster', 'protest', 'strike', 'lawsuit', 'company', 'global'],
    weak: ['today', 'yesterday', 'this week', 'happening', 'update', 'event'],
    bigrams: ['just announced', 'breaking news', 'sources confirm', 'just happened', 'this morning', 'last night', 'live updates'],
    patterns: [
      /today|this morning|last night|just now/i,
      /\b(\d+\s*(dead|injured|arrested|missing))\b/i,
      /official(ly)?|confirmed|breaking/i,
    ],
    boosters: [/🚨|📰|🗞️/u, /developing story|live updates/i],
    negations: [/rumor|allegedly|unconfirmed|satire/i],
    flairKeywords: ['news', 'update', 'announcement', 'breaking', 'world events', 'current events', 'happening'],
  },

  science: {
    strong: ['study', 'research', 'scientists', 'discovered', 'theory', 'hypothesis', 'experiment', 'data', 'evidence', 'peer reviewed', 'published', 'journal', 'findings'],
    medium: ['physics', 'biology', 'chemistry', 'astronomy', 'neuroscience', 'psychology', 'statistics', 'correlation', 'causation', 'meta-analysis', 'control group', 'placebo', 'evolution', 'quantum'],
    weak: ['science', 'fact', 'learn', 'interesting', 'explain', 'knowledge'],
    bigrams: ['according to study', 'new research', 'data shows', 'scientists find', 'breakthrough discovery', 'how it works', 'new finding'],
    patterns: [
      /according to (a |the )?(study|research|paper|report)/i,
      /\b(\d+\.?\d*\s*%\s*(more|less|higher|lower|increase|decrease))\b/i,
      /new (discovery|breakthrough|finding|species)/i,
    ],
    boosters: [/mind.?blowing|fascinating|surprising|remarkable/i],
    negations: [],
    flairKeywords: ['science', 'research', 'study', 'knowledge', 'education', 'explainer', 'deep dive', 'analysis', 'facts'],
  },

  music: {
    strong: ['song', 'album', 'track', 'artist', 'band', 'lyrics', 'beat', 'remix', 'playlist', 'release', 'single', 'ep', 'lp', 'verse', 'chorus', 'hook', 'feature', 'collab'],
    medium: ['spotify', 'apple music', 'soundcloud', 'youtube music', 'concert', 'tour', 'setlist', 'vinyl', 'genre', 'hip hop', 'rap', 'rock', 'pop', 'edm', 'jazz', 'classical', 'r&b', 'producer', 'drop'],
    weak: ['music', 'listen', 'hearing', 'melody', 'bass', 'vocals'],
    bigrams: ['new album', 'just dropped', 'favorite song', 'listening to', 'on repeat', 'music video', 'world tour', 'sold out'],
    patterns: [
      /\b(new|favorite|best|worst)\s+(song|album|track|release)\b/i,
      /just (dropped|released|announced)/i,
      /lyrics? (to|of|for|about)/i,
    ],
    boosters: [/🎵|🎶|🎸|🎤|🥁/u, /banger|earworm|certified/i],
    negations: [],
    flairKeywords: ['music', 'song', 'album', 'artist', 'playlist', 'audio', 'band', 'rap', 'rock', 'pop'],
  },

  animals: {
    strong: ['dog', 'cat', 'puppy', 'kitten', 'pet', 'rescue', 'adopt', 'foster', 'paw', 'fur baby', 'goodboy', 'floof', 'boop', 'aww', 'vet'],
    medium: ['animal', 'wildlife', 'bird', 'fish', 'reptile', 'hamster', 'rabbit', 'ferret', 'horse', 'zoo', 'sanctuary', 'shelter', 'species', 'habitat'],
    weak: ['cute', 'fluffy', 'sweet', 'precious', 'adorable', 'wholesome'],
    bigrams: ['my dog', 'my cat', 'just adopted', 'rescue dog', 'shelter cat', 'baby animal', 'look at this'],
    patterns: [
      /aww+|so cute|look at (this|my|him|her)/i,
      /\b(my|our|this)\s+(dog|cat|puppy|kitten|pet|bird|hamster|rabbit)\b/i,
    ],
    boosters: [/🐶|🐱|🐾|🐼|🦎|🐦/u, /heart melt|precious|goodest/i],
    negations: [],
    flairKeywords: ['animals', 'pets', 'cute', 'wildlife', 'nature', 'dogs', 'cats', 'aww'],
  },

  entertainment: {
    strong: ['movie', 'film', 'series', 'show', 'season', 'episode', 'actor', 'actress', 'director', 'trailer', 'spoiler', 'plot', 'character', 'screenplay', 'casting'],
    medium: ['netflix', 'hbo', 'disney', 'amazon prime', 'hulu', 'marvel', 'dc', 'star wars', 'anime', 'oscar', 'emmy', 'ending', 'finale', 'cameo', 'rewatch', 'binge'],
    weak: ['watch', 'tv', 'cinema', 'screen', 'scene'],
    bigrams: ['just finished', 'just watched', 'best scene', 'plot twist', 'new season', 'new episode', 'final episode', 'mid credits'],
    patterns: [
      /\b(new|latest|upcoming)\s+(movie|season|episode|trailer)\b/i,
      /\b(watched|rewatched|binged|finished)\b/i,
      /favorite (character|scene|moment|episode)/i,
    ],
    boosters: [/🎬|🎥|📺/u, /mind blown|didn't see that coming/i],
    negations: [],
    flairKeywords: ['movies', 'film', 'tv', 'shows', 'entertainment', 'media', 'anime', 'series', 'review', 'spoiler', 'recommendation'],
  },

  visual: {
    strong: ['pic', 'photo', 'image', 'screenshot', 'art', 'drawing', 'painting', 'illustration', 'render', 'oc', 'fanart', 'photography', 'sketch', 'design'],
    medium: ['beautiful', 'stunning', 'aesthetic', 'wallpaper', 'portrait', 'landscape', 'ai generated', 'digital art', 'watercolor', 'oil painting', 'commissioned', 'gallery'],
    weak: ['look', 'check out', 'visual', 'wow', 'amazing'],
    bigrams: ['check this out', 'here is my', 'i made this', 'just finished', 'took this', 'shot this', 'first time drawing'],
    patterns: [
      /\.(jpg|jpeg|png|gif|webp|svg)(\s|$)/i,
      /here.?s? (my|the|a)\s+(drawing|photo|art|pic|painting)/i,
      /\b(oc|original content|my art)\b/i,
    ],
    boosters: [/🎨|📸|🖼️/u, /inspo|reference|wip|work in progress/i],
    negations: [],
    flairKeywords: ['art', 'photos', 'images', 'visual', 'pictures', 'photography', 'drawings', 'showcase', 'oc', 'fanart', 'gallery'],
  },

  technology: {
    strong: ['software', 'hardware', 'programming', 'coding', 'developer', 'api', 'open source', 'github', 'docker', 'kubernetes', 'cloud', 'deployment', 'bug', 'framework', 'library'],
    medium: ['iphone', 'android', 'apple', 'google', 'microsoft', 'linux', 'windows', 'macos', 'cpu', 'gpu', 'ram', 'ssd', 'startup', 'saas', 'machine learning', 'llm', 'neural network', 'cybersecurity', 'code review', 'best practices', 'workflow', 'collaborative', 'version control', 'devops', 'ci/cd', 'agile', 'scrum'],
    weak: ['tech', 'app', 'device', 'digital', 'internet', 'computer', 'ai'],
    bigrams: ['open source', 'pull request', 'just shipped', 'new version', 'side project', 'tech stack', 'breaking change', 'zero day'],
    patterns: [
      /\b(v\d+\.\d+|version \d+)/i,
      /\b(apple|google|microsoft|samsung|tesla|nvidia|openai)\b.{0,40}(announc|launch|releas|acqui)/i,
      /open source|github\.com|npm install/i,
    ],
    boosters: [/💻|🖥️|⚙️/u, /revolutionary|game changer|next gen/i],
    negations: [],
    flairKeywords: ['tech', 'technology', 'software', 'hardware', 'coding', 'dev', 'programming', 'ai', 'tools', 'apps', 'gadgets'],
  },

  finance: {
    // Separated from "personal development" — finance has distinct vocabulary
    strong: ['stock', 'crypto', 'bitcoin', 'ethereum', 'invest', 'portfolio', 'dividend', 'earnings', 'revenue', 'ipo', 'hedge fund', 'short sell', 'options', 'etf', 'compound interest'],
    medium: ['market', 'economy', 'inflation', 'recession', 'budget', 'savings', 'debt', 'mortgage', 'retirement', 'passive income', 'side hustle', 'frugal', 'fire movement', 'net worth', 'salary', 'raise'],
    weak: ['money', 'earn', 'save', 'spend', 'rich', 'wealth', 'financial'],
    bigrams: ['financial freedom', 'financial independence', 'debt free', 'net worth', 'how much', 'living below', 'emergency fund', 'index fund'],
    patterns: [
      /\$\d+[k]?|\d+[k]\s*(per|a)\s*(year|month|week)/i,
      /how (to|much|can i)\s+(make|save|invest|retire)/i,
      /\b(bull|bear)\s+market\b/i,
    ],
    boosters: [/💰|📈|📉|💸/u, /ngmi|wagmi|to the moon|rug pull/i],
    negations: [],
    flairKeywords: ['finance', 'investing', 'money', 'crypto', 'stocks', 'budget', 'economics', 'frugal', 'fire', 'wealth'],
  },

  health: {
    strong: ['workout', 'gym', 'fitness', 'diet', 'nutrition', 'protein', 'calories', 'weight loss', 'mental health', 'therapy', 'anxiety', 'depression', 'sleep', 'recovery', 'injury', 'surgery'],
    medium: ['exercise', 'running', 'lifting', 'cardio', 'meal prep', 'supplement', 'routine', 'streak', 'progress', 'transformation', 'mindfulness', 'meditation', 'hydration', 'intermittent fasting'],
    weak: ['healthy', 'body', 'mind', 'wellness', 'habit', 'clean eating'],
    bigrams: ['personal record', 'before and after', 'day streak', 'lost weight', 'gained muscle', 'mental health', 'self care', 'rest day'],
    patterns: [
      /\b(lost|gained)\s+\d+\s*(lbs|kg|pounds|kilos)\b/i,
      /\b(pr|personal record|new max)\b/i,
      /day \d+ of/i,
    ],
    boosters: [/💪|🏋️|🏃|🥗/u, /transformation|glow up|before after/i],
    negations: [],
    flairKeywords: ['health', 'fitness', 'gym', 'wellness', 'mental health', 'diet', 'nutrition', 'workout', 'running', 'training'],
  },

  politics: {
    // The definitive home for political content — takes trump/biden/election from news
    strong: ['trump', 'biden', 'harris', 'democrat', 'republican', 'election', 'vote', 'ballot', 'congress', 'senate', 'policy', 'legislation', 'bill', 'rights', 'constitution', 'supreme court'],
    medium: ['liberal', 'conservative', 'progressive', 'left wing', 'right wing', 'socialism', 'capitalism', 'populism', 'fascism', 'government', 'protest', 'activist', 'reform', 'immigration', 'climate change', 'racism', 'feminism', 'equality'],
    weak: ['political', 'society', 'issue', 'woke', 'system', 'power'],
    bigrams: ['culture war', 'cancel culture', 'free speech', 'human rights', 'social justice', 'tax policy', 'should the government'],
    patterns: [
      /should (we|they|the government|congress)\b/i,
      /\b(ban|legalize|defund|tax|regulate)\b.{0,40}(gun|drug|speech|police|corp)/i,
      /\b(left|right)\b.{0,20}\b(wing|leaning|wing)\b/i,
    ],
    boosters: [/outrage|hypocrisy|accountability|corruption/i],
    negations: [],
    flairKeywords: ['politics', 'political', 'election', 'government', 'policy', 'social issues', 'rights', 'activism', 'current events'],
  },

  hobbies: {
    strong: ['collection', 'hobby', 'diy', 'handmade', 'custom build', 'warhammer', 'miniature', '3d print', 'lego', 'cosplay', 'knitting', 'crochet', 'woodworking', 'pottery', 'gardening', 'birdwatching'],
    medium: ['setup', 'build', 'progress pic', 'wip', 'haul', 'thrift', 'vintage', 'antique', 'craft', 'workshop', 'maker', 'etsy', 'commission', 'scale model', 'tabletop'],
    weak: ['passion', 'interest', 'project', 'creative', 'making'],
    bigrams: ['my collection', 'my setup', 'my build', 'just finished', 'work in progress', 'anyone else into', 'rate my', 'finally done'],
    patterns: [
      /my (collection|setup|build|workshop|haul)/i,
      /\b(scale|miniature|3d.?print|hand.?made)\b/i,
      /anyone (else )?(into|who does)/i,
    ],
    boosters: [/nerd|geek|enthusiast|obsessed/i],
    negations: [],
    flairKeywords: ['hobbies', 'hobby', 'diy', 'craft', 'crafts', 'creative', 'project', 'maker', 'collection', 'build'],
  },

  community: {
    strong: ['subreddit', 'this sub', 'mods', 'moderator', 'rule', 'ban', 'karma', 'upvote', 'downvote', 'op', 'aita', 'tifu', 'rant', 'announcement', 'welcome'],
    medium: ['reddit', 'community', 'post', 'comment', 'thread', 'flair', 'sidebar', 'wiki', 'pinned', 'megathread', 'feedback', 'suggestion', 'meta'],
    weak: ['here', 'this place', 'everyone'],
    bigrams: ['am i the', 'today i fucked', 'this subreddit', 'new here', 'long time lurker', 'first post'],
    patterns: [
      /r\/\w+/i,
      /\b(aita|wibta|tifu|tihi|eli5)\b/i,
      /this (sub|subreddit|community)/i,
    ],
    boosters: [/mods? (are|will|should)|rule \d+/i],
    negations: [],
    flairKeywords: ['meta', 'community', 'announcement', 'mod', 'rules', 'feedback', 'welcome', 'pinned', 'megathread'],
  },
};

// Scoring weights — tuned so a post needs genuine category presence to cross thresholds
const W = {
  strong: 20,          // first strong hit; each additional is worth slightly less (diminishing returns)
  strongExtra: 14,     // 2nd+ strong hits
  medium: 10,
  weak: 4,
  bigram: 16,          // two-word phrase is a stronger signal than a single word
  pattern: 22,
  booster: 11,
  negation: -35,
  densityBonus: 18,    // awarded when 3+ strong keywords fire (signals truly on-topic content)
  questionBonus: 14,   // for discussion: ends with ? or starts with question word
  personalBonus: 8,    // "I/my/me" boosts personal categories (health, hobbies, finance)
};

class FlairDetector {
  scoreAll(content: string): Record<ContentCategory, number> {
    const lower = content.toLowerCase();
    const words = lower.replace(/[^\w\s?!.]/g, ' ').split(/\s+/).filter(Boolean);
    const bigrams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) bigrams.add(`${words[i]} ${words[i + 1]}`);

    const hasPersonal = /\b(i |i'm |my |me |i've |i'll )/i.test(content);
    const isQuestion = /\?/.test(content) || /^\s*(what|how|why|when|who|does|is|are|should|would|could|can)\b/i.test(content);

    const result = {} as Record<ContentCategory, number>;

    for (const [cat, def] of Object.entries(CATEGORIES) as [ContentCategory, CategoryDef][]) {
      let score = 0;

      // Strong keywords with diminishing returns
      let strongHits = 0;
      for (const kw of def.strong) {
        if (lower.includes(kw)) {
          score += strongHits === 0 ? W.strong : W.strongExtra;
          strongHits++;
        }
      }
      if (strongHits >= 3) score += W.densityBonus;

      // Medium keywords
      for (const kw of def.medium) {
        if (lower.includes(kw)) score += W.medium;
      }

      // Weak keywords
      for (const kw of def.weak) {
        if (lower.includes(kw)) score += W.weak;
      }

      // Bigram phrases
      for (const bg of def.bigrams) {
        if (bigrams.has(bg) || lower.includes(bg)) score += W.bigram;
      }

      // Regex patterns
      for (const p of def.patterns) {
        if (p.test(lower)) score += W.pattern;
      }

      // Context boosters
      for (const b of def.boosters) {
        if (b.test(content)) score += W.booster;
      }

      // Negation penalties
      for (const n of def.negations) {
        if (n.test(lower)) score += W.negation;
      }

      // Structural bonuses
      if (cat === 'discussion' && isQuestion) score += W.questionBonus;
      if ((cat === 'health' || cat === 'hobbies' || cat === 'finance') && hasPersonal) score += W.personalBonus;
      if (cat === 'visual' && (lower.includes('http') || lower.includes('imgur') || lower.includes('i.redd.it'))) score += 28;

      result[cat] = Math.max(0, Math.min(150, score));
    }

    return result;
  }

  // Map a flair name to the category it most likely represents, then return that category's content score
  matchFlairToScore(flair: string, scores: Record<ContentCategory, number>): number {
    const flairLower = flair.toLowerCase();
    let bestCat: ContentCategory | null = null;
    let bestCatScore = 0;

    for (const [cat, def] of Object.entries(CATEGORIES) as [ContentCategory, CategoryDef][]) {
      const hits = def.flairKeywords.filter((kw) => flairLower.includes(kw)).length;
      if (hits > bestCatScore) {
        bestCatScore = hits;
        bestCat = cat;
      }
    }

    if (!bestCat || bestCatScore === 0) {
      // No category mapping found — fall back to direct word-in-content check
      const flairWords = flairLower.split(/\W+/).filter((w) => w.length > 3);
      if (flairWords.length === 0) return 0;
      // Give a baseline score proportional to flair word hits in content
      return Math.max(...Object.values(scores)) > 40 ? 0 : 0;
    }

    return scores[bestCat];
  }
}

const flairDetector = new FlairDetector();

// ─── HeuristicProvider ─────────────────────────────────────────────────────────

export class HeuristicProvider implements AIProvider {
  // eslint-disable-next-line @typescript-eslint/require-await
  async analyzeAppeal(
    appealText: string,
    userHistory: UserHistory
  ): Promise<AIAnalysisResult> {
    const flags: string[] = [];
    let confidence = 0.5;

    if (hasBadFaithPattern(appealText)) {
      flags.push('bad_faith');
      confidence -= 0.2;
    }

    const sincerityScore = sincerity(appealText);
    if (sincerityScore >= 2) {
      confidence += 0.15;
    } else if (sincerityScore === 0 && appealText.length < 80) {
      flags.push('low_effort');
      confidence -= 0.1;
    }

    if (userHistory.tempBanCount >= 2 || userHistory.permBanHistory > 0) {
      flags.push('repeat_offender');
      confidence -= 0.1;
    }

    if (userHistory.appealCount >= 3) {
      flags.push('repeat_appealer');
    }

    const hasCaps = (appealText.match(PATTERNS.ALL_CAPS_WORD) ?? []).length >= 3;
    if (hasCaps) {
      flags.push('aggressive_tone');
      confidence -= 0.05;
    }

    const suggestedAction =
      confidence >= 0.6 ? 'approve' : confidence <= 0.3 ? 'remove' : 'flag';

    const sentences = appealText.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const summary =
      sentences.length > 0
        ? sentences.slice(0, 2).join('. ') + '.'
        : appealText.slice(0, 200);

    const reasoning = [
      `Sincerity signals: ${sincerityScore}`,
      flags.length > 0 ? `Flags: ${flags.join(', ')}` : 'No negative flags',
      `Prior infractions: bans=${userHistory.tempBanCount + userHistory.permBanHistory}`,
    ].join(' | ');

    return {
      summary,
      confidence: Math.max(0, Math.min(1, confidence)),
      flags,
      suggestedAction,
      reasoning,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async analyzeContent(
    content: string,
    _context: ContentContext
  ): Promise<AIAnalysisResult> {
    const toxicity = computeToxicityScore(content);
    const flags = [...toxicity.signals];

    let suggestedAction: AIAnalysisResult['suggestedAction'] = 'none';
    if (toxicity.score >= 0.7) suggestedAction = 'remove';
    else if (toxicity.score >= 0.4) suggestedAction = 'flag';

    return {
      summary: content.slice(0, 200),
      confidence: toxicity.score,
      flags,
      suggestedAction,
      reasoning: `Heuristic toxicity score: ${toxicity.score.toFixed(2)}. Signals: ${toxicity.signals.join(', ') || 'none'}`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async suggestFlair(
    content: string,
    existingFlairs: string[]
  ): Promise<{ suggested: string; confidence: number }> {
    if (existingFlairs.length === 0) return { suggested: '', confidence: 0 };

    const scores = flairDetector.scoreAll(content);
    let bestFlair = '';
    let bestScore = 0;

    for (const flair of existingFlairs) {
      const score = flairDetector.matchFlairToScore(flair, scores);
      if (score > bestScore) { bestScore = score; bestFlair = flair; }
    }

    // Cascade penalty: if winner isn't clearly ahead of second place, reduce confidence
    const allScores = existingFlairs.map((f) => flairDetector.matchFlairToScore(f, scores)).sort((a, b) => b - a);
    const margin = allScores.length > 1 ? bestScore - (allScores[1] ?? 0) : bestScore;
    const penalized = margin < 15 ? bestScore * 0.8 : bestScore;

    // Normalize: ~80 → 1.0, ~56 → 0.7 (auto-apply threshold), ~32 → 0.4 (suggest threshold)
    return { suggested: bestFlair, confidence: Math.min(1, penalized / 80) };
  }
}
