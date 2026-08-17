'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, '{}');

let jobs = {};
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch (e) { jobs = {}; }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), () => {});
  }, 50);
}

function createJob(id, initial) {
  jobs[id] = { id, createdAt: Date.now(), paid: false, ...initial };
  persist();
  return jobs[id];
}
function getJob(id) { return jobs[id]; }
function updateJob(id, patch) {
  if (!jobs[id]) return null;
  Object.assign(jobs[id], patch);
  persist();
  return jobs[id];
}

module.exports = { createJob, getJob, updateJob };
