/**
 * Elo rating engine matching the iOS app's EloEngine.
 * K-factor = 32 (standard for recreational play).
 */

const K = 32;

export function calculateEloChange(
  winnerElo: number,
  loserElo: number,
): { winnerDelta: number; loserDelta: number } {
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 - expectedWinner;

  const winnerDelta = Math.round(K * (1 - expectedWinner));
  const loserDelta = Math.round(K * (0 - expectedLoser));

  return { winnerDelta, loserDelta };
}
