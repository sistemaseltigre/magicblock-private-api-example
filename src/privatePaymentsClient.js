const nacl = require('tweetnacl');
const { Connection, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } = require('@solana/spl-token');
const { getAuthToken } = require('@magicblock-labs/ephemeral-rollups-sdk');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeLegacyTransaction(base64) {
  return Transaction.from(Buffer.from(String(base64 || ''), 'base64'));
}

function getWritableAccounts(transaction, includeFeePayer = false) {
  const writable = new Set();
  if (includeFeePayer && transaction.feePayer) {
    writable.add(transaction.feePayer.toBase58());
  }
  for (const instruction of transaction.instructions || []) {
    for (const key of instruction.keys || []) {
      if (key.isWritable) {
        writable.add(key.pubkey.toBase58());
      }
    }
  }
  return Array.from(writable);
}

class PrivatePaymentsClient {
  constructor({
    keypair,
    cluster = 'devnet',
    baseRpcUrl = 'https://api.devnet.solana.com',
    paymentsApiUrl = 'https://payments.magicblock.app',
    teeUrl = 'https://devnet-tee.magicblock.app',
    validatorId = 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
    mint = 'So11111111111111111111111111111111111111112',
  }) {
    this.keypair = keypair;
    this.cluster = cluster;
    this.baseRpcUrl = baseRpcUrl;
    this.paymentsApiUrl = paymentsApiUrl;
    this.teeUrl = teeUrl;
    this.validatorId = validatorId;
    this.mint = mint;
    this.baseConnection = new Connection(this.baseRpcUrl, 'confirmed');
    this._auth = null;
  }

  get walletAddress() {
    return this.keypair.publicKey.toBase58();
  }

  async paymentsRequest(pathname, payload) {
    const response = await fetch(`${this.paymentsApiUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error?.message || json?.message || `${pathname} failed`);
    }
    return json;
  }

  async getTeeAuth() {
    if (this._auth && Date.now() < (Number(this._auth.expiresAt || 0) - 30_000)) {
      return this._auth;
    }
    this._auth = await getAuthToken(
      this.teeUrl,
      this.keypair.publicKey,
      (message) => Promise.resolve(nacl.sign.detached(message, this.keypair.secretKey))
    );
    return this._auth;
  }

  async teeRpc(method, params = []) {
    const auth = await this.getTeeAuth();
    const response = await fetch(`${this.teeUrl}?token=${auth.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    });
    const json = await response.json();
    if (json?.error) {
      throw new Error(json.error.message || `TEE RPC ${method} failed`);
    }
    return json.result;
  }

  async getTeeIdentity() {
    const result = await this.teeRpc('getIdentity');
    return String(result?.identity || '');
  }

  async isMintInitialized() {
    const params = new URLSearchParams({
      mint: this.mint,
      cluster: this.cluster,
      validator: this.validatorId,
    });
    const response = await fetch(`${this.paymentsApiUrl}/v1/spl/is-mint-initialized?${params.toString()}`);
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error?.message || 'is-mint-initialized failed');
    }
    return json;
  }

  async ensureMintInitialized() {
    const status = await this.isMintInitialized();
    if (status.initialized) {
      return { initialized: true, signature: null };
    }
    const built = await this.paymentsRequest('/v1/spl/initialize-mint', {
      payer: this.walletAddress,
      mint: this.mint,
      cluster: this.cluster,
      validator: this.validatorId,
    });
    const signature = await this.submitBuiltTransaction(built);
    return { initialized: true, signature };
  }

  async wrapSolIfNeeded(targetLamports) {
    const owner = this.keypair.publicKey;
    const mint = new PublicKey(this.mint);
    const ata = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mint,
      owner
    );
    const info = await this.baseConnection.getAccountInfo(ata);
    let current = 0;
    if (info) {
      const balance = await this.baseConnection.getTokenAccountBalance(ata);
      current = Number(balance?.value?.amount || 0);
    }
    if (current >= targetLamports) {
      return { wrapped: false, ata: ata.toBase58(), currentLamports: current };
    }

    const needed = targetLamports - current;
    const instructions = [];
    if (!info) {
      instructions.push(
        Token.createAssociatedTokenAccountInstruction(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          NATIVE_MINT,
          ata,
          owner,
          owner
        )
      );
    }
    instructions.push(SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ata,
      lamports: needed,
    }));
    instructions.push(Token.createSyncNativeInstruction(TOKEN_PROGRAM_ID, ata));
    const tx = new Transaction().add(...instructions);
    const latest = await this.baseConnection.getLatestBlockhash('confirmed');
    tx.feePayer = owner;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(this.keypair);
    const signature = await this.baseConnection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.baseConnection.confirmTransaction(signature, 'confirmed');
    return { wrapped: true, ata: ata.toBase58(), signature, currentLamports: current + needed };
  }

  async transferSolIfNeeded({ recipient, minimumLamports }) {
    const recipientKey = new PublicKey(recipient);
    const balance = await this.baseConnection.getBalance(recipientKey, 'confirmed');
    if (balance >= minimumLamports) {
      return { funded: false, balanceLamports: balance };
    }
    const lamports = minimumLamports - balance;
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey,
      toPubkey: recipientKey,
      lamports,
    }));
    const latest = await this.baseConnection.getLatestBlockhash('confirmed');
    tx.feePayer = this.keypair.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(this.keypair);
    const signature = await this.baseConnection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.baseConnection.confirmTransaction(signature, 'confirmed');
    return { funded: true, balanceLamports: minimumLamports, signature, lamports };
  }

  async buildDeposit({ owner, amountLamports }) {
    return this.paymentsRequest('/v1/spl/deposit', {
      owner,
      amount: amountLamports,
      cluster: this.cluster,
      mint: this.mint,
      validator: this.validatorId,
      initIfMissing: true,
      initVaultIfMissing: true,
    });
  }

  async buildPrivateTransfer({ from, to, amountLamports, memo }) {
    return this.paymentsRequest('/v1/spl/transfer', {
      from,
      to,
      amount: amountLamports,
      cluster: this.cluster,
      mint: this.mint,
      visibility: 'private',
      validator: this.validatorId,
      memo,
      fromBalance: 'ephemeral',
      toBalance: 'ephemeral',
    });
  }

  async buildWithdraw({ owner, amountLamports }) {
    return this.paymentsRequest('/v1/spl/withdraw', {
      owner,
      amount: amountLamports,
      cluster: this.cluster,
      mint: this.mint,
      validator: this.validatorId,
    });
  }

  async submitBuiltTransaction(built) {
    const transaction = decodeLegacyTransaction(built.transactionBase64);
    transaction.feePayer = this.keypair.publicKey;

    if (String(built.sendTo) === 'ephemeral') {
      const writableAccounts = getWritableAccounts(transaction, false);
      const blockhashResult = await this.teeRpc('getBlockhashForAccounts', [writableAccounts]);
      const blockhash = blockhashResult?.value?.blockhash;
      if (!blockhash) {
        throw new Error('Missing ephemeral blockhash');
      }
      transaction.recentBlockhash = blockhash;
      transaction.sign(this.keypair);
      const signature = await this.teeRpc('sendTransaction', [
        transaction.serialize().toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ]);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await sleep(1000);
        const statuses = await this.teeRpc('getSignatureStatuses', [[signature]]);
        const status = statuses?.value?.[0] || null;
        if (status?.err) {
          throw new Error(`ephemeral_transaction_failed:${JSON.stringify(status.err)}`);
        }
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
          break;
        }
      }
      return signature;
    }

    transaction.sign(this.keypair);
    const signature = await this.baseConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.baseConnection.confirmTransaction(signature, 'confirmed');
    return signature;
  }
}

module.exports = {
  PrivatePaymentsClient,
};
