'use strict';
// Resolves the request context from ?team_id=. Omitted -> personal (set by auth).
// Present -> that team, but only after verifying the team exists and the caller is a member.
// Import the members file directly to avoid circular entity-index deps.
const { teamExists, roleOf } = require('../entities/teams/db/members');

const httpError = (message, status) => Object.assign(new Error(message), { status });

module.exports = (req, res, next) => {
  const { isAdmin } = req.context;
  const raw = req.query.team_id;

  if (raw) {
    const teamId = Number(raw);
    if (!Number.isInteger(teamId) || teamId <= 0) return next(httpError('team_id must be a positive integer', 400));
    if (!teamExists(teamId)) return next(httpError('Team not found', 404));

    // Admin reaches any team without membership; everyone else must be a member.
    const role = isAdmin ? 'owner' : roleOf(req.userId, teamId);
    if (!role) return next(httpError('Not a member of this team', 403));

    req.context = { userId: req.userId, teamId, role, isAdmin };
    return next();
  }

  // Personal context. An admin may target any user's personal data via ?user_id=.
  if (isAdmin && req.query.user_id) {
    const targetUserId = Number(req.query.user_id);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) return next(httpError('user_id must be a positive integer', 400));
    req.context = { ...req.context, targetUserId };
  }
  next(); // absent team_id -> personal context (already on req.context)
};
