const bs58Lib = require('bs58');
const { Keypair } = require('@solana/web3.js');

const bs58 = bs58Lib.decode ? bs58Lib : bs58Lib.default;

function parseKeypair(secret) {
  const raw = String(secret || '').trim();
  if (!raw) {
    throw new Error('SERVER_PRIVATE_KEY is missing');
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (_) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
}

module.exports = {
  parseKeypair,
};

