import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readSettings, sleep } from "../utils/utils";
import { HIGHER_MC_INTERVAL, HIGHER_TP_INTERVAL, LOWER_MC_INTERVAL, LOWER_TP_INTERVAL, PRIVATE_KEY, PUMP_SWAP_PROGRAM_ID, SELL_TIMER, solanaConnection, STOP_LOSS } from "../constants";
import base58 from "bs58";
import { logger, wrapSol } from "../utils";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, NATIVE_MINT } from "@solana/spl-token";
import { mainMenuWaiting } from "..";
import { PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { Direction } from "../types"; // Ensure Direction is imported as an enum
import BN from "bn.js";

export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY!))

async function getPoolBaseTokenAccount(poolAddress: string) {
    const [baseTokenAccount] = await PublicKey.findProgramAddress(
        [
            Buffer.from("base_token_account"),
            new PublicKey(poolAddress).toBuffer(),
        ],
        new PublicKey(PUMP_SWAP_PROGRAM_ID!) // Replace with actual PumpSwap program ID
    );

    return baseTokenAccount;
}

async function getPoolQuoteTokenAccount(poolAddress: string) {
    const [baseTokenAccount] = await PublicKey.findProgramAddress(
        [
            Buffer.from("quote_token_account"),
            new PublicKey(poolAddress).toBuffer(),
        ],
        new PublicKey(PUMP_SWAP_PROGRAM_ID!) // Replace with actual PumpSwap program ID
    );

    return baseTokenAccount;
}

export const buy_monitor_autosell = async () => {
    const pSwap = new PumpAmmSdk(solanaConnection);
    const data = readSettings();
    const BUY_AMOUNT = Number(data.amount);
    const TOKEN_CA = new PublicKey(data.mint!);
    const IS_PUMPFUN = data.isPump!;
    const SLIPPAGE = Number(data.slippage);

    let settings = {
        mint: new PublicKey(data.mint!),
        poolId: new PublicKey(data.poolId!),
        isPump: data.isPump!,
        amount: Number(data.amount),
        slippage: Number(data.slippage)
    }

    const POOL_ID = settings.poolId;
    const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL;

    const baseAta = await getAssociatedTokenAddress(TOKEN_CA, POOL_ID, true);;
    const quoteAta = await getAssociatedTokenAddress(NATIVE_MINT, POOL_ID, true);

    if (solBalance < Number(BUY_AMOUNT)) {
        logger.error(`There is not enough balance in your wallet. Please deposit some more solana to continue.`)
        return
    }
    logger.info(`Pumpswap Trading bot is running`)
    logger.info(`Wallet address: ${mainKp.publicKey.toBase58()}`)
    logger.info(`Balance of the main wallet: ${solBalance}Sol`)

    await wrapSol(mainKp, Number(BUY_AMOUNT) * 2)

    let middleMC = await getTokenMC(quoteAta, baseAta, IS_PUMPFUN, settings.mint)
    let mc = Math.floor(middleMC)
    let lowerMC = mc * (1 - LOWER_MC_INTERVAL / 100)
    let higherMC = mc * (1 + HIGHER_MC_INTERVAL / 100)
    const mcCheckInterval = 200
    let mcChecked = 0
    let bought = false
    let processingToken = false

    logger.info(`Starting MarketCap monitoring, initial MC is ${middleMC}Sol ...`)

    while (1) {

        let tpInterval
        processingToken = true

        while (1) {
            if (mcChecked != 0) {
                middleMC = await getTokenMC(quoteAta, baseAta, IS_PUMPFUN, settings.mint)
                // middleHolderNum = (await findHolders(mintStr)).size
            }
            if (mcChecked > 100000) {
                bought = false
                processingToken = false
                break;
            }
            if (middleMC < 35) {
                bought = false
                processingToken = false
                break;
            }

            logger.info(`Current MC: ${middleMC}Sol, LMC: ${lowerMC}Sol, HMC: ${higherMC}Sol`)

            if (middleMC < lowerMC) {
                logger.info(`Market Cap keep decreasing now, reached ${lowerMC}Sol, keep monitoring...`)
                mc = Math.floor(middleMC)
                lowerMC = mc * (1 - LOWER_MC_INTERVAL / 100)
                higherMC = mc * (1 + HIGHER_MC_INTERVAL / 100)
            }

            await sleep(mcCheckInterval)
            mcChecked++

        }

        if (bought) {
            mcChecked = 0
            if (middleMC > 1000) tpInterval = 1
            else tpInterval = 1
            // Waiting for the AssociatedTokenAccount is confirmed
            const maxRetries = 50
            const delayBetweenRetries = 1000
            let tokenAccountInfo
            const ata = await getAssociatedTokenAddress(TOKEN_CA, mainKp.publicKey)

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    tokenAccountInfo = await getAccount(solanaConnection, ata, "processed");
                    const tokenAmount = Number((await solanaConnection.getTokenAccountBalance(ata)).value.amount);

                    // Monitoring pnl
                    attempt = maxRetries
                    const amountIn = tokenAmount

                    try {

                        logger.info("Showing pnl monitoring...")
                        const priceCheckInterval = 200
                        const timesToCheck = SELL_TIMER / priceCheckInterval
                        let TP_LEVEL = 1.5
                        let higherTP = TP_LEVEL + HIGHER_TP_INTERVAL
                        let lowerTP = TP_LEVEL - LOWER_TP_INTERVAL

                        const SolOnSl = Number((Number(BUY_AMOUNT) * (100 - STOP_LOSS) / 100).toFixed(6))
                        let timesChecked = 0
                        let tpReached = false
                        do {

                            try {
                                // Quote to Base swap (⬇️)
                                const amountOut = Number(await pSwap.swapAutocompleteBaseFromQuote(
                                    POOL_ID,
                                    new BN(amountIn),
                                    SLIPPAGE,
                                    "quoteToBase",
                                ));

                                const pnl = (Number(amountOut.toFixed(7)) - Number(BUY_AMOUNT)) / Number(BUY_AMOUNT) * 100

                                if (pnl > TP_LEVEL && !tpReached) {
                                    tpReached = true
                                    logger.info(`PNL is reached to the lowest Profit level ${TP_LEVEL}%`)
                                }

                                if (pnl > 0)
                                    if (pnl > higherTP) {
                                        // TP_LEVEL = Math.floor(pnl / (tpInterval / 2)) * (tpInterval / 2)
                                        TP_LEVEL = pnl

                                        logger.info(`Token price goes up and up, so raising take profit from ${lowerTP + tpInterval / 2}% to ${TP_LEVEL}%`)

                                        higherTP = TP_LEVEL + HIGHER_TP_INTERVAL
                                        lowerTP = TP_LEVEL - LOWER_TP_INTERVAL
                                    } else if (pnl < lowerTP && tpReached) {
                                        logger.fatal("Token is on profit level, price starts going down, selling tokens...")
                                        try {
                                            await swap(pSwap, POOL_ID, TOKEN_CA, new BN(tokenAmount), SLIPPAGE, mainKp, "baseToQuote");
                                            break;
                                        } catch (err) {
                                            logger.info("Fail to sell tokens ...")
                                        }
                                    }

                            } catch (e) {
                                // logger.error(e)
                            } finally {
                                timesChecked++
                            }
                            await sleep(priceCheckInterval)
                            if (timesChecked >= timesToCheck) {
                                await swap(pSwap, POOL_ID, TOKEN_CA, new BN(tokenAmount), SLIPPAGE, mainKp, "baseToQuote");
                                break
                            }
                        } while (1)

                        logger.warn(`New pumpswap token ${TOKEN_CA.toBase58()} PNL processing finished once and continue monitoring MarketCap`)
                        // logger.info(`Waiting 5 seconds for new buying and selling...`)
                        await sleep(1000)
                        // await wrapSol(mainKp, BUY_AMOUNT * 1.1)

                        middleMC = await getTokenMC(quoteAta, baseAta, IS_PUMPFUN, settings.mint)
                        // middleHolderNum = (await findHolders(mintStr)).size
                        mc = Math.floor(middleMC)
                        lowerMC = mc * (1 - LOWER_MC_INTERVAL / 100)
                        higherMC = mc * (1 + HIGHER_MC_INTERVAL / 100)

                    } catch (error) {
                        logger.error("Error when setting profit amounts", error)
                        mainMenuWaiting()
                    }

                    // break; // Break the loop if fetching the account was successful
                } catch (error) {
                    if (error instanceof Error && error.name === 'TokenAccountNotFoundError') {
                        logger.info(`Attempt ${attempt + 1}/${maxRetries}: Associated token account not found, retrying...`);
                        if (attempt === maxRetries - 1) {
                            logger.error(`Max retries reached. Failed to fetch the token account.`);
                            mainMenuWaiting()
                        }
                        // Wait before retrying
                        await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                    } else if (error instanceof Error) {
                        // logger.error(`Unexpected error while fetching token account: ${error.message}`);
                        // throw error;
                        logger.info(`Attempt ${attempt + 1}/${maxRetries}: Associated token account not found, retrying...`);
                        if (attempt === maxRetries - 1) {
                            logger.error(`Max retries reached. Failed to fetch the token account.`);
                            mainMenuWaiting()
                        }
                        await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));

                    } else {
                        logger.error(`An unknown error occurred: ${String(error)}`);
                        throw error;
                    }
                }
            }
        }

        if (!processingToken) {
            mainMenuWaiting()
            break;
        }

    }
}

export const swap = async (pSwap: PumpAmmSdk, pool: PublicKey, mint: PublicKey, buyAmount: BN, slippage: number, user: Keypair, direction: Direction) => {
    const baseAta = await getOrCreateAssociatedTokenAccount(solanaConnection, user, mint, user.publicKey, true);
    const quoteAta = await getOrCreateAssociatedTokenAccount(solanaConnection, user, NATIVE_MINT, user.publicKey, true);
    try {

        const buyTx = new Transaction();

        if (direction == "quoteToBase") {
            buyTx.add(
                createAssociatedTokenAccountIdempotentInstruction(user.publicKey, baseAta.address, user.publicKey, mint),
                createAssociatedTokenAccountIdempotentInstruction(user.publicKey, quoteAta.address, user.publicKey, NATIVE_MINT),
                SystemProgram.transfer({
                    fromPubkey: user.publicKey,
                    toPubkey: quoteAta.address,
                    lamports: Number(buyAmount),
                }),
                createSyncNativeInstruction(quoteAta.address)
            );
        }

        //swapInstruction
        
        console.log("🚀 ~ buy ~ swapInstructions:", swapInstructions)

        buyTx.add(...swapInstructions);
        buyTx.feePayer = user.publicKey;
        buyTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash

        try {
            const simulationResult = await solanaConnection.simulateTransaction(buyTx);
            const { value } = simulationResult;
            console.log("🚀 ~ buy ~ value:", value)
            if (value.err) {
                logger.error("Simulation failed:", value.err);
            } else {
                logger.info("Simulation successful:", value.logs);
            }
        } catch (error: any) {
            throw new Error(`Transaction simulation failed: ${error.message}`)
        }

        const createSig = await sendAndConfirmTransaction(solanaConnection, buyTx, [user]);
        console.log("Create BondingCurve Sig : ", createSig);
    } catch (error) {
        console.log("error => ", error)
    }
}

const getTokenPrice = async (quoteVault: PublicKey, baseVault: PublicKey, isPump: Boolean) => {
    const quoteBal = (await solanaConnection.getTokenAccountBalance(quoteVault)).value.uiAmount
    const baseBal = (await solanaConnection.getTokenAccountBalance(baseVault)).value.uiAmount

    let price: number = 0

    if (isPump) {
        price = baseBal! / quoteBal!
    }
    else {
        price = quoteBal! / baseBal!
    }
    // console.log("price of the token: ", price)
    return price
}

const getTokenMC = async (quoteVault: PublicKey, baseVault: PublicKey, isPump: Boolean, mint: PublicKey) => {
    const currentPrice = await getTokenPrice(quoteVault, baseVault, isPump)
    const totalSupply = (await solanaConnection.getTokenSupply(mint)).value.uiAmount
    return currentPrice * totalSupply!
}
