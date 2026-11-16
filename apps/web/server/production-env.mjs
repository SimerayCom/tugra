// Side-effect module: imported first by server.mjs, before `next`. The stock `next start` defaults NODE_ENV to
// production; our custom entry calls next() directly, so without this the container (no NODE_ENV) would run Next in
// non-production mode and render server error messages and stacks into the HTML. An explicit NODE_ENV still wins.
process.env.NODE_ENV ||= "production";
