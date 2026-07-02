'use strict';
// supertest agent over the Express app (no listen) + auth helpers.
const request = require('supertest');
require('./db'); // schema must exist before the app handles a request
const app = require('../../src/app');

const login = async (email, password) => {
  const res = await request(app).post('/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
};

// api(token).post('/teams', {...}) — keeps the Bearer header in one place.
const api = (token) => ({
  get:  (url)       => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url, body) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  put:  (url, body) => request(app).put(url).set('Authorization', `Bearer ${token}`).send(body),
  del:  (url)       => request(app).delete(url).set('Authorization', `Bearer ${token}`),
});

module.exports = { app, request, login, api };
