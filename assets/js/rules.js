import { money } from './lib.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Plain-language rules, shown to voters on the voting page and to the
// admin as a live preview while editing Voting rules.
export function rulesList(e) {
  const r = [];
  r.push(e.voting_mode === 'criteria'
    ? `Rate the contestant on each criterion from 1 to ${e.score_max}.`
    : 'Pick the contestant you want to vote for.');
  r.push(e.pricing === 'paid'
    ? `${money(e.price_per_vote, e.currency)} per vote. Votes count once the organizer confirms your payment.`
    : 'Voting is free.');
  r.push(e.max_votes_per_voter > 0
    ? `Each person can cast ${plural(e.max_votes_per_voter, 'vote')} in total.`
    : 'There is no limit on the number of votes.');
  if (e.max_contestants_per_voter > 0) r.push(`You can vote for up to ${plural(e.max_contestants_per_voter, 'contestant')}.`);
  r.push(e.allow_repeat_contestant ? 'You can vote for the same contestant more than once.' : 'Only one vote per contestant.');
  const domains = String(e.email_domains || '').split(/[\s,;]+/).map((x) => x.replace(/^@+/, '')).filter(Boolean);
  if (e.ask_email && domains.length) r.push(`Only ${domains.map((d) => '@' + d).join(' or ')} email addresses can vote.`);
  r.push('Each device can only vote within these limits, even from a different browser. Repeat or fake votes are detected and blocked.');
  if (e.block_private) r.push('Private / incognito windows cannot vote.');
  if (e.ends_at) r.push(`Voting ends ${new Date(e.ends_at).toLocaleString()}.`);
  return r;
}
