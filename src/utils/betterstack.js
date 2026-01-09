const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const BETTERSTACK_ENDPOINT = "https://in.logs.betterstack.com";

async function logEvent(event) {
  try {
    await fetch(BETTERSTACK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.BETTERSTACK_TOKEN}`
      },
      body: JSON.stringify(event)
    });
  } catch (err) {
    console.error("BetterStack log failed:", err.message);
  }
}

module.exports = { logEvent };
