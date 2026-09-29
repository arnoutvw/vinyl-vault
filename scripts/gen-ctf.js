#!/usr/bin/env node
'use strict';

/*
 * Generates docker-compose.ctf.yml + monitoring/prometheus/prometheus.ctf.yml
 * for N teams, with:
 *   - one isolated docker network per team (teams cannot attack each other)
 *   - per-team random JWT secret
 *   - CPU/memory limits per instance
 *   - healthchecks on /api/health
 *
 * Usage:
 *   node scripts/gen-ctf.js --teams 5
 *   node scripts/gen-ctf.js --names "Team Red,Team Blue"
 *   node scripts/gen-ctf.js --teams 5 --base-port 3000
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = { teams: null, names: null, basePort: 3000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teams') args.teams = parseInt(argv[++i], 10);
    else if (a === '--names') args.names = argv[++i];
    else if (a === '--base-port') args.basePort = parseInt(argv[++i], 10);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (args.names) {
    args.teamList = args.names.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (args.teams) {
    args.teamList = Array.from({ length: args.teams }, (_, i) => `Team ${i + 1}`);
  } else {
    console.error('Provide --teams N or --names "A,B,C"');
    process.exit(1);
  }
  if (args.teamList.length < 1) {
    console.error('Need at least one team');
    process.exit(1);
  }
  return args;
}

const slug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';

const secret = () => crypto.randomBytes(32).toString('hex');

function appService(team, index, basePort) {
  const s = slug(team);
  const hostPort = basePort + index * 10;
  return `  vv-${s}:
    build: .
    container_name: vv-${s}
    environment:
      - VV_DEFAULT_TEAM=${team}
      - PORT=3000
      - JWT_SECRET=${secret()}
    ports:
      - "${hostPort}:3000"
    volumes:
      - vv-${s}-data:/app/data
    networks:
      - net-${s}
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s`;
}

function promJob(team) {
  const s = slug(team);
  return `  - job_name: "vinyl-vault-${s}"
    metrics_path: /metrics
    static_configs:
      - targets: ["vv-${s}:3000"]`;
}

function compose(teams, basePort) {
  const services = teams.map((t, i) => appService(t, i, basePort)).join('\n\n');
  const teamNetworks = teams.map((t) => `  net-${slug(t)}: {}`).join('\n');
  return `# ---------------------------------------------------------------------------
# CTF mode: ONE Vinyl Vault instance PER TEAM, a SINGLE Prometheus and a
# SINGLE Grafana aggregating every team's score.
#
# GENERATED FILE — do not edit by hand. Regenerate with:
#   node scripts/gen-ctf.js --teams <N>   (or --names "A,B,C")
#
# Each app instance is pinned to a team via VV_DEFAULT_TEAM, isolated on its
# own docker network (teams cannot reach each other's instances), has its own
# JWT secret, and is capped at 1 CPU / 512M. Prometheus joins every team
# network to scrape them; the CTF Scoreboard dashboard aggregates
# with \`sum by (team) (...)\`.
# ---------------------------------------------------------------------------

services:
${services}

  prometheus:
    image: prom/prometheus:latest
    container_name: vv-prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus/prometheus.ctf.yml:/etc/prometheus/prometheus.yml:ro
      - vv-prometheus-data:/prometheus
    networks:
${teams.map((t) => `      - net-${slug(t)}`).join('\n')}
      - monitoring
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: vv-grafana
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=${secret()}
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
      - GF_USERS_DEFAULT_THEME=dark
    volumes:
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro
      - vv-grafana-data:/var/lib/grafana
    networks:
      - monitoring
    depends_on:
      - prometheus
    restart: unless-stopped

networks:
${teamNetworks}
  monitoring: {}

volumes:
${teams.map((t) => `  vv-${slug(t)}-data: {}`).join('\n')}
  vv-prometheus-data: {}
  vv-grafana-data: {}
`;
}

function prometheusConfig(teams) {
  return `global:
  scrape_interval: 5s
  evaluation_interval: 5s

# GENERATED FILE — regenerate with: node scripts/gen-ctf.js
# One scrape job per team instance. Each app labels its own metrics with
# team="..." (via VV_DEFAULT_TEAM); the CTF Scoreboard dashboard aggregates
# with \`sum by (team) (...)\`.
scrape_configs:
${teams.map(promJob).join('\n\n')}

  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]
`;
}

const args = parseArgs(process.argv);
const root = path.join(__dirname, '..');

fs.writeFileSync(path.join(root, 'docker-compose.ctf.yml'), compose(args.teamList, args.basePort));
fs.writeFileSync(
  path.join(root, 'monitoring/prometheus/prometheus.ctf.yml'),
  prometheusConfig(args.teamList)
);

console.log(`Generated CTF stack for ${args.teamList.length} team(s):`);
args.teamList.forEach((t, i) => {
  console.log(`  ${t.padEnd(20)} http://<host>:${args.basePort + i * 10}`);
});
console.log('  Grafana               http://<host>:3001 (admin / see docker-compose.ctf.yml)');
console.log('\nGrafana admin password is in the generated docker-compose.ctf.yml.');
console.log('Keep that file on the operator machine only — it contains secrets.');
console.log('\nReset between runs: docker compose -f docker-compose.ctf.yml down -v');