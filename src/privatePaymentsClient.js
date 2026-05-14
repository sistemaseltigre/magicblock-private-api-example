const bs58Lib = require('bs58');
const nacl = require('tweetnacl');
const { TextEncoder } = require('util');
const { Connection, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } = require('@solana/spl-token');
const { getAuthToken: getSdkAuthToken } = require('@magicblock-labs/ephemeral-rollups-sdk');

const bs58 = bs58Lib.decode ? bs58Lib : bs58Lib.default;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeLegacyTransaction(base64) {
  return Transaction.from(Buffer.from(String(base64 || ''), 'base64'));
}

function toBase64Transaction(transaction) {
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString('base64');
}

function getRequiredSigners(transaction) {
  return (transaction.signatures || []).map((entry) => entry.publicKey.toBase58());
}

function getWritableAccounts(transaction, includeFeePayer = false) {
  const writable = new Set();
  if (includeFeePayer && transaction.feePayer) {
    writable.add(transaction.feePayer.toBase58());
  }
  for (const instruction of transaction.instructions || []) {
    for (const key of instruction.keys || []) {
      if (key.isWritable) writable.add(key.pubkey.toBase58());
    }
  }
  return Array.from(writable);
}

function nonComputeInstructionFingerprint(transaction) {
  const message = transaction.compileMessage();
  const accountKeys = message.accountKeys.map((key) => key.toBase58());
  return message.instructions
    .map((instruction) => {
      const programId = accountKeys[instruction.programIdIndex] || '';
      return {
        programId,
        accounts: Array.from(instruction.accounts || []).map((index) => accountKeys[index] || ''),
        data: String(instruction.data || ''),
      };
    })
    .filter((instruction) => instruction.programId !== COMPUTE_BUDGET_PROGRAM_ID);
}

class PrivatePaymentsClient {
  constructor({
    keypair,
    cluster = 'devnet',
    baseRpcUrl = 'https://api.devnet.solana.com',
    paymentsApiUrl = 'https://payments.magicblock.app',
    teeUrl = 'https://devnet-tee.magicblock.app',
    validatorId = 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
    mint = NATIVE_MINT.toBase58(),
  }) {
    if (!keypair) throw new Error('keypair_required');
    this.keypair = keypair;
    this.cluster = cluster;
    this.baseRpcUrl = baseRpcUrl;
    this.paymentsApiUrl = String(paymentsApiUrl || '').replace(/\/$/, '');
    this.teeUrl = String(teeUrl || '').replace(/\/$/, '');
    this.validatorId = validatorId;
    this.mint = mint;
    this.baseConnection = new Connection(this.baseRpcUrl, 'confirmed');
    this._teeAuthToken = null;
    this._teeAuthTokenExpiresAt = 0;
    this._paymentsAuthToken = null;
    this._paymentsAuthTokenExpiresAt = 0;
  }

  get walletAddress() {
    return this.keypair.publicKey.toBase58();
  }

  async paymentsRequest(pathname, payload, { auth = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.getPaymentsAuthToken()}`;

    const response = await fetch(`${this.paymentsApiUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.error?.message || json?.error || json?.message || `${pathname}_failed`);
    }
    return json;
  }

  async getPaymentsAuthToken() {
    const now = Date.now();
    if (this._paymentsAuthToken && now < (this._paymentsAuthTokenExpiresAt - 30_000)) {
      return this._paymentsAuthToken;
    }

    const pubkey = this.walletAddress;
    const params = new URLSearchParams({ pubkey, cluster: this.cluster });
    const challengeResponse = await fetch(`${this.paymentsApiUrl}/v1/spl/challenge?${params.toString()}`);
    const challengeJson = await challengeResponse.json().catch(() => ({}));
    if (!challengeResponse.ok) {
      throw new Error(`payments_challenge_failed:${challengeJson?.error || challengeJson?.message || challengeResponse.statusText}`);
    }

    const challenge = String(challengeJson?.challenge || challengeJson?.message || '').trim();
    if (!challenge) throw new Error('payments_challenge_missing');

    const signatureBytes = nacl.sign.detached(new TextEncoder().encode(challenge), this.keypair.secretKey);
    const basePayload = {
      pubkey,
      challenge,
      signature: bs58.encode(signatureBytes),
      cluster: this.cluster,
    };

    let loginResponse = await fetch(`${this.paymentsApiUrl}/v1/spl/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basePayload),
    });
    let loginJson = await loginResponse.json().catch(() => ({}));

    if (!loginResponse.ok) {
      loginResponse = await fetch(`${this.paymentsApiUrl}/v1/spl/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...basePayload,
          signature: Buffer.from(signatureBytes).toString('base64'),
        }),
      });
      loginJson = await loginResponse.json().catch(() => ({}));
    }

    if (!loginResponse.ok) {
      throw new Error(`payments_login_failed:${loginJson?.error || loginJson?.message || loginResponse.statusText}`);
    }

    const token = String(loginJson?.token || '').trim();
    if (!token) throw new Error('payments_auth_token_missing');
    const rawExpiresAt = loginJson?.expiresAt || loginJson?.expires_at || 0;
    const parsedExpiresAt = Number(rawExpiresAt) || Date.parse(String(rawExpiresAt || ''));

    this._paymentsAuthToken = token;
    this._paymentsAuthTokenExpiresAt = Number.isFinite(parsedExpiresAt) && parsedExpiresAt > now
      ? parsedExpiresAt
      : now + 5 * 60 * 1000;
    return token;
  }

  async getTeeAuthToken() {
    const now = Date.now();
    if (this._teeAuthToken && now < (this._teeAuthTokenExpiresAt - 30_000)) {
      return this._teeAuthToken;
    }

    try {
      this._teeAuthToken = await this.getPaymentsAuthToken();
      this._teeAuthTokenExpiresAt = this._paymentsAuthTokenExpiresAt;
      return this._teeAuthToken;
    } catch (paymentsError) {
      const sdkAuth = await getSdkAuthToken(
        this.teeUrl,
        this.keypair.publicKey,
        (message) => Promise.resolve(nacl.sign.detached(message, this.keypair.secretKey))
      ).catch((sdkError) => {
        throw new Error(`${paymentsError.message}; sdk_auth_failed:${sdkError.message || sdkError}`);
      });
      this._teeAuthToken = sdkAuth?.token || null;
      this._teeAuthTokenExpiresAt = Number(sdkAuth?.expiresAt || 0) || now + 5 * 60 * 1000;
    }

    if (!this._teeAuthToken) throw new Error('tee_auth_token_missing');
    return this._teeAuthToken;
  }

  async teeRpc(method, params = []) {
    const token = await this.getTeeAuthToken();
    const response = await fetch(`${this.teeUrl}?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await response.json().catch(() => ({}));
    if (json?.error) throw new Error(json.error.message || `tee_rpc_${method}_failed`);
    return json.result;
  }

  async getTeeIdentity() {
    const result = await this.teeRpc('getIdentity');
    return String(result?.identity || '');
  }

  async getBaseTokenBalanceLamports(ownerAddress = this.walletAddress) {
    const owner = new PublicKey(String(ownerAddress || '').trim());
    const mint = new PublicKey(this.mint);
    const ata = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mint,
      owner
    );
    const info = await this.baseConnection.getAccountInfo(ata);
    if (!info) return { ata: ata.toBase58(), amountLamports: 0 };
    const balance = await this.baseConnection.getTokenAccountBalance(ata);
    return { ata: ata.toBase58(), amountLamports: Number(balance?.value?.amount || 0) };
  }

  async waitForBaseTokenBalanceLamports(ownerAddress, minimumLamports, { attempts = 12, delayMs = 1000 } = {}) {
    let lastBalance = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      lastBalance = await this.getBaseTokenBalanceLamports(ownerAddress);
      if (lastBalance.amountLamports >= Number(minimumLamports || 0)) return lastBalance;
      await sleep(delayMs);
    }
    return lastBalance;
  }

  async getPrivateTokenBalanceLamports(ownerAddress = this.walletAddress) {
    const params = new URLSearchParams({
      address: String(ownerAddress || '').trim(),
      mint: this.mint,
      cluster: this.cluster,
    });
    const response = await fetch(`${this.paymentsApiUrl}/v1/spl/private-balance?${params.toString()}`, {
      headers: { Authorization: `Bearer ${await this.getPaymentsAuthToken()}` },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.error?.message || json?.error || json?.message || 'private_balance_failed');
    }
    const rawAmount = json?.amount || json?.balance || json?.tokenAmount?.amount || json?.value?.amount || 0;
    return {
      owner: String(ownerAddress || '').trim(),
      amountLamports: Number(rawAmount || 0),
      raw: json,
    };
  }

  async isMintInitialized() {
    const params = new URLSearchParams({
      mint: this.mint,
      cluster: this.cluster,
      validator: this.validatorId,
    });
    const response = await fetch(`${this.paymentsApiUrl}/v1/spl/is-mint-initialized?${params.toString()}`);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error?.message || json?.message || 'is_mint_initialized_failed');
    return json;
  }

  async ensureMintInitialized() {
    const status = await this.isMintInitialized();
    if (status?.initialized) return { ...status, initializeSignature: null };
    const built = await this.paymentsRequest('/v1/spl/initialize-mint', {
      payer: this.walletAddress,
      mint: this.mint,
      cluster: this.cluster,
      validator: this.validatorId,
    });
    const initializeSignature = await this.signAndSubmitBuiltTransaction(built);
    return { ...status, initialized: true, initializeSignature };
  }

  async wrapSolIfNeeded(targetLamports) {
    const owner = this.keypair.publicKey;
    const mint = new PublicKey(this.mint);
    if (!mint.equals(NATIVE_MINT)) {
      return { wrapped: false, reason: 'mint_is_not_native_sol' };
    }

    const ata = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      NATIVE_MINT,
      owner
    );
    const info = await this.baseConnection.getAccountInfo(ata);
    let currentLamports = 0;
    if (info) {
      const balance = await this.baseConnection.getTokenAccountBalance(ata);
      currentLamports = Number(balance?.value?.amount || 0);
    }
    if (currentLamports >= Number(targetLamports || 0)) {
      return { wrapped: false, ata: ata.toBase58(), currentLamports };
    }

    const missingLamports = Number(targetLamports || 0) - currentLamports;
    const instructions = [];
    if (!info) {
      instructions.push(Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        NATIVE_MINT,
        ata,
        owner,
        owner
      ));
    }
    instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: missingLamports }));
    instructions.push(Token.createSyncNativeInstruction(TOKEN_PROGRAM_ID, ata));

    const transaction = new Transaction().add(...instructions);
    const latest = await this.baseConnection.getLatestBlockhash('confirmed');
    transaction.feePayer = owner;
    transaction.recentBlockhash = latest.blockhash;
    transaction.sign(this.keypair);

    const signature = await this.baseConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 2,
    });
    await this.baseConnection.confirmTransaction(signature, 'confirmed');
    return { wrapped: true, ata: ata.toBase58(), currentLamports: currentLamports + missingLamports, signature };
  }

  async transferSolIfNeeded({ recipient, minimumLamports }) {
    const recipientKey = new PublicKey(String(recipient || '').trim());
    const balance = await this.baseConnection.getBalance(recipientKey, 'confirmed');
    if (balance >= Number(minimumLamports || 0)) {
      return { funded: false, balanceLamports: balance };
    }
    const lamports = Number(minimumLamports || 0) - balance;
    const transaction = new Transaction().add(SystemProgram.transfer({
      fromPubkey: this.keypair.publicKey,
      toPubkey: recipientKey,
      lamports,
    }));
    const latest = await this.baseConnection.getLatestBlockhash('confirmed');
    transaction.feePayer = this.keypair.publicKey;
    transaction.recentBlockhash = latest.blockhash;
    transaction.sign(this.keypair);
    const signature = await this.baseConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 2,
    });
    await this.baseConnection.confirmTransaction(signature, 'confirmed');
    return { funded: true, balanceLamports: minimumLamports, lamports, signature };
  }

  async buildDeposit({ owner, amountLamports }) {
    await this.ensureMintInitialized();
    return this.paymentsRequest('/v1/spl/deposit', {
      owner: String(owner || '').trim(),
      amount: Number(amountLamports || 0),
      cluster: this.cluster,
      mint: this.mint,
      validator: this.validatorId,
      initIfMissing: true,
      initVaultIfMissing: true,
    });
  }

  async buildPrivateTransfer({ from, to, amountLamports, memo }) {
    await this.ensureMintInitialized();
    return this.paymentsRequest('/v1/spl/transfer', {
      owner: String(from || '').trim(),
      destination: String(to || '').trim(),
      from: String(from || '').trim(),
      to: String(to || '').trim(),
      amount: Number(amountLamports || 0),
      cluster: this.cluster,
      mint: this.mint,
      privacy: 'private',
      visibility: 'private',
      validator: this.validatorId,
      memo: String(memo || '').slice(0, 64),
      fromBalance: 'ephemeral',
      toBalance: 'ephemeral',
    }, { auth: true });
  }

  async buildBaseToPrivateTransfer({ from, to, amountLamports, memo }) {
    await this.ensureMintInitialized();
    return this.paymentsRequest('/v1/spl/transfer', {
      owner: String(from || '').trim(),
      destination: String(to || '').trim(),
      from: String(from || '').trim(),
      to: String(to || '').trim(),
      amount: Number(amountLamports || 0),
      cluster: this.cluster,
      mint: this.mint,
      privacy: 'private',
      visibility: 'private',
      validator: this.validatorId,
      memo: String(memo || '').slice(0, 64),
      fromBalance: 'base',
      toBalance: 'ephemeral',
      initIfMissing: true,
      initVaultIfMissing: true,
      initAtasIfMissing: true,
      idempotent: true,
    }, { auth: true });
  }

  async buildWithdraw({ owner, amountLamports }) {
    await this.ensureMintInitialized();
    return this.paymentsRequest('/v1/spl/withdraw', {
      owner: String(owner || '').trim(),
      amount: Number(amountLamports || 0),
      cluster: this.cluster,
      mint: this.mint,
      validator: this.validatorId,
    });
  }

  assertUnsignedTransactionSigner({ transactionBase64, signerWallet, label = 'transaction' }) {
    const expectedWallet = String(signerWallet || '').trim();
    const transaction = decodeLegacyTransaction(transactionBase64);
    const feePayer = transaction.feePayer ? transaction.feePayer.toBase58() : '';
    const requiredSigners = getRequiredSigners(transaction);
    if (feePayer && feePayer !== expectedWallet) {
      throw new Error(`${label}_fee_payer_mismatch:${feePayer}`);
    }
    if (!requiredSigners.includes(expectedWallet)) {
      throw new Error(`${label}_required_signer_mismatch:${requiredSigners.join(',') || 'none'}`);
    }
    return { feePayer, requiredSigners };
  }

  verifySignedTransactionMatches({ signedTransactionBase64, expectedUnsignedTransactionBase64, signerWallet }) {
    const signedTransaction = decodeLegacyTransaction(signedTransactionBase64);
    const expectedTransaction = decodeLegacyTransaction(expectedUnsignedTransactionBase64);
    this.verifySignedTransactionSignerOnly(signedTransaction, signerWallet);

    const signedMessage = Buffer.from(signedTransaction.serializeMessage()).toString('hex');
    const expectedMessage = Buffer.from(expectedTransaction.serializeMessage()).toString('hex');
    if (signedMessage !== expectedMessage) {
      const signedFingerprint = nonComputeInstructionFingerprint(signedTransaction);
      const expectedFingerprint = nonComputeInstructionFingerprint(expectedTransaction);
      if (JSON.stringify(signedFingerprint) !== JSON.stringify(expectedFingerprint)) {
        throw new Error('signed_transaction_mismatch:non_compute_instructions_or_accounts_changed');
      }
    }
    return signedTransaction;
  }

  verifySignedTransactionSignerOnly(signedTransaction, signerWallet) {
    const expectedWallet = String(signerWallet || '').trim();
    const feePayer = signedTransaction.feePayer ? signedTransaction.feePayer.toBase58() : '';
    if (feePayer !== expectedWallet) throw new Error('signed_transaction_fee_payer_mismatch');
    if (!signedTransaction.verifySignatures()) throw new Error('signed_transaction_invalid_signature');
    return true;
  }

  async submitSignedTransaction({
    signedTransactionBase64,
    expectedUnsignedTransactionBase64,
    signerWallet,
    sendTo = 'base',
    verificationMode = 'strict',
  }) {
    const transaction = verificationMode === 'signerOnly'
      ? decodeLegacyTransaction(signedTransactionBase64)
      : this.verifySignedTransactionMatches({
          signedTransactionBase64,
          expectedUnsignedTransactionBase64,
          signerWallet,
        });
    if (verificationMode === 'signerOnly') {
      this.verifySignedTransactionSignerOnly(transaction, signerWallet);
    }

    if (String(sendTo || '').toLowerCase() === 'ephemeral') {
      const signature = await this.teeRpc('sendTransaction', [
        signedTransactionBase64,
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ]);
      await this.waitForEphemeralSignature(signature);
      return { signature, sendTo: 'ephemeral' };
    }

    const signature = await this.baseConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 2,
    });
    const confirmation = await this.baseConnection.confirmTransaction(signature, 'confirmed');
    if (confirmation?.value?.err) {
      throw new Error(`base_transaction_failed:${JSON.stringify(confirmation.value.err)}`);
    }
    return { signature, sendTo: 'base' };
  }

  async signAndSubmitBuiltTransaction(built, signerKeypair = this.keypair) {
    const transaction = decodeLegacyTransaction(built.transactionBase64);
    transaction.feePayer = signerKeypair.publicKey;

    if (String(built.sendTo || '').toLowerCase() === 'ephemeral') {
      const writableAccounts = getWritableAccounts(transaction, false);
      const blockhashResult = await this.teeRpc('getBlockhashForAccounts', [writableAccounts]);
      const blockhash = blockhashResult?.value?.blockhash;
      if (!blockhash) throw new Error('ephemeral_blockhash_missing');
      transaction.recentBlockhash = blockhash;
      transaction.sign(signerKeypair);
      const signature = await this.teeRpc('sendTransaction', [
        toBase64Transaction(transaction),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ]);
      await this.waitForEphemeralSignature(signature);
      return signature;
    }

    transaction.sign(signerKeypair);
    const signature = await this.baseConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 2,
    });
    const confirmation = await this.baseConnection.confirmTransaction(signature, 'confirmed');
    if (confirmation?.value?.err) {
      throw new Error(`base_transaction_failed:${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  }

  async waitForEphemeralSignature(signature, attempts = 15) {
    const value = String(signature || '').trim();
    if (!value) throw new Error('ephemeral_send_signature_missing');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(1000);
      const statusResult = await this.teeRpc('getSignatureStatuses', [[value]]);
      const status = statusResult?.value?.[0] || null;
      if (status?.err) throw new Error(`ephemeral_transaction_failed:${JSON.stringify(status.err)}`);
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return status;
      }
    }
    return null;
  }
}

module.exports = {
  PrivatePaymentsClient,
  decodeLegacyTransaction,
  toBase64Transaction,
};
