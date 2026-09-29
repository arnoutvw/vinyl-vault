'use strict';

/*
 * Prometheus metrics for Vinyl Vault.
 * Exposes default Node process metrics plus a set of custom business/security
 * metrics that the bundled Grafana dashboard visualises.
 */

const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ app: 'vinyl-vault' });

// Standard Node.js / process metrics (CPU, memory, event loop, GC, ...).
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'vv_http_requests_total',
  help: 'Total number of HTTP requests handled.',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'vv_http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const loginAttemptsTotal = new client.Counter({
  name: 'vv_login_attempts_total',
  help: 'Login attempts, labelled by result (success|failure).',
  labelNames: ['result'],
  registers: [register],
});

const ordersCreatedTotal = new client.Counter({
  name: 'vv_orders_created_total',
  help: 'Total number of orders placed.',
  registers: [register],
});

const orderValue = new client.Histogram({
  name: 'vv_order_value_eur',
  help: 'Distribution of order totals in EUR.',
  buckets: [5, 10, 20, 40, 80, 160, 320],
  registers: [register],
});

const reviewsPostedTotal = new client.Counter({
  name: 'vv_reviews_posted_total',
  help: 'Total number of product reviews posted.',
  registers: [register],
});

const challengesSolvedTotal = new client.Counter({
  name: 'vv_challenges_solved_total',
  help: 'Number of training challenges solved (fires when a flaw is triggered).',
  labelNames: ['challenge'],
  registers: [register],
});

const usersRegistered = new client.Gauge({
  name: 'vv_users_registered',
  help: 'Current number of registered users.',
  registers: [register],
});

const teamScore = new client.Gauge({
  name: 'vv_team_score',
  help: 'Current CTF score per team.',
  labelNames: ['team'],
  registers: [register],
});

const teamChallengeSolved = new client.Gauge({
  name: 'vv_team_challenge_solved',
  help: 'Set to 1 when a team has solved a given challenge (else absent).',
  labelNames: ['team', 'challenge', 'difficulty'],
  registers: [register],
});

const teamHintsUsed = new client.Counter({
  name: 'vv_team_hints_used_total',
  help: 'Number of paid hints unlocked per team.',
  labelNames: ['team'],
  registers: [register],
});

const teamPointsSpentHints = new client.Gauge({
  name: 'vv_team_hint_points_spent',
  help: 'Total points a team has spent on hints.',
  labelNames: ['team'],
  registers: [register],
});

const firstBloodTotal = new client.Counter({
  name: 'vv_first_blood_total',
  help: 'First-blood bonuses awarded, by team and difficulty tier.',
  labelNames: ['team', 'difficulty'],
  registers: [register],
});

// Express middleware that records request count + latency.
function httpMetricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // Use the matched route pattern when available to keep label cardinality low.
    const route = (req.route && req.baseUrl + req.route.path) || req.path || 'unknown';
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    end(labels);
  });
  next();
}

function resetScoreboard() {
  teamScore.reset();
  teamChallengeSolved.reset();
  teamHintsUsed.reset();
  teamPointsSpentHints.reset();
  firstBloodTotal.reset();
}

module.exports = {
  client,
  register,
  httpMetricsMiddleware,
  metrics: {
    loginAttemptsTotal,
    ordersCreatedTotal,
    orderValue,
    reviewsPostedTotal,
    challengesSolvedTotal,
    usersRegistered,
    teamScore,
    teamChallengeSolved,
    teamHintsUsed,
    teamPointsSpentHints,
    firstBloodTotal,
    resetScoreboard,
  },
};
