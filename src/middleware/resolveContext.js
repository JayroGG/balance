'use strict';
// Resolves the request context from ?team_id=. Omitted -> personal (set by auth).
// Present -> that team, but only after verifying the team exists and the caller is a member.
// Import the members file directly to avoid circular entity-index deps.
const { teamExists, isMember } = require('../entities/teams/db/members');

const httpError = (message, status) => Object.assign(new Error(message), { status });

module.exports = (req, res, next) => {
  const raw = req.query.team_id;
  if (!raw) return next(); // absent/empty -> personal context (already on req.context)

  const teamId = Number(raw);
  if (!Number.isInteger(teamId) || teamId <= 0) return next(httpError('team_id must be a positive integer', 400));
  if (!teamExists(teamId)) return next(httpError('Team not found', 404));
  if (!isMember(req.userId, teamId)) return next(httpError('Not a member of this team', 403));

  req.context = { userId: req.userId, teamId };
  next();
};
