import * as anchor from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import * as wormholeSdk from "@certusone/wormhole-sdk";
import {
    AddressLookupTableProgram,
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import { expectIxOk, getUsdcAtaBalance, hackedExpectDeepEqual } from "./helpers";
import { FEE_UPDATER_KEYPAIR } from "./helpers";
import { SwapLayerProgram, localnet, Custodian, Peer } from "../src/swapLayer";
import { use as chaiUse, expect } from "chai";
import * as matchingEngineSdk from "../../../lib/example-liquidity-layer/solana/ts/src/matchingEngine";
import * as tokenRouterSdk from "../../../lib/example-liquidity-layer/solana/ts/src/tokenRouter";
import {
    LiquidityLayerDeposit,
    LiquidityLayerMessage,
} from "../../../lib/example-liquidity-layer/solana/ts/src/common";
import {
    postLiquidityLayerVaa,
    LOCALHOST,
    PAYER_KEYPAIR,
    OWNER_KEYPAIR,
    OWNER_ASSISTANT_KEYPAIR,
    USDC_MINT_ADDRESS,
    ETHEREUM_USDC_ADDRESS,
    MOCK_GUARDIANS,
    CircleAttester,
} from "../../../lib/example-liquidity-layer/solana/ts/tests/helpers";
import { VaaAccount } from "../../../lib/example-liquidity-layer/solana/ts/src/wormhole";
import { CctpTokenBurnMessage } from "../../../lib/example-liquidity-layer/solana/ts/src/cctp";

chaiUse(require("chai-as-promised"));

describe("Swap Layer", () => {
    const connection = new Connection(LOCALHOST, "processed");
    const payer = PAYER_KEYPAIR;
    const owner = OWNER_KEYPAIR;
    const recipient = Keypair.generate();
    const ownerAssistant = OWNER_ASSISTANT_KEYPAIR;
    const feeUpdater = FEE_UPDATER_KEYPAIR;
    const feeRecipient = Keypair.generate();
    const feeRecipientToken = splToken.getAssociatedTokenAddressSync(
        USDC_MINT_ADDRESS,
        feeRecipient.publicKey,
    );

    // Sending chain information.
    const foreignChain = wormholeSdk.CHAINS.ethereum;
    const foreignTokenRouterAddress = Array.from(Buffer.alloc(32, "f0", "hex"));
    const foreignSwapLayerAddress = Array.from(
        Buffer.alloc(32, "000000000000000000000000deadbeefCf7178C407aA7369b67CB7e0274952e2", "hex"),
    );
    const foreignCctpDomain = 0;

    // Program SDKs
    const swapLayer = new SwapLayerProgram(connection, localnet(), USDC_MINT_ADDRESS);
    const tokenRouter = new tokenRouterSdk.TokenRouterProgram(
        connection,
        tokenRouterSdk.localnet(),
        USDC_MINT_ADDRESS,
    );
    const matchingEngine = new matchingEngineSdk.MatchingEngineProgram(
        connection,
        matchingEngineSdk.localnet(),
        USDC_MINT_ADDRESS,
    );

    let tokenRouterLkupTable: PublicKey;

    describe("Admin", () => {
        describe("Initialize", () => {
            it("Initialize", async () => {
                const ix = await swapLayer.initializeIx({
                    owner: payer.publicKey,
                    ownerAssistant: ownerAssistant.publicKey,
                    feeRecipient: feeRecipient.publicKey,
                    feeUpdater: feeUpdater.publicKey,
                });

                await expectIxOk(connection, [ix], [payer]);

                const custodianData = await swapLayer.fetchCustodian();

                hackedExpectDeepEqual(
                    custodianData,
                    new Custodian(
                        payer.publicKey,
                        null,
                        ownerAssistant.publicKey,
                        feeRecipientToken,
                        feeUpdater.publicKey,
                    ),
                );
            });

            before("Set up Token Accounts", async function () {
                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    feeRecipient.publicKey,
                );

                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    PublicKey.default,
                );

                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    SystemProgram.programId,
                );

                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    recipient.publicKey,
                );
            });

            after("Setup Lookup Table", async function () {
                // Create.
                const [createIx, lookupTable] = await connection.getSlot("finalized").then((slot) =>
                    AddressLookupTableProgram.createLookupTable({
                        authority: payer.publicKey,
                        payer: payer.publicKey,
                        recentSlot: slot,
                    }),
                );

                await expectIxOk(connection, [createIx], [payer]);

                const usdcCommonAccounts = await tokenRouter.commonAccounts();

                // Extend.
                const extendIx = AddressLookupTableProgram.extendLookupTable({
                    payer: payer.publicKey,
                    authority: payer.publicKey,
                    lookupTable,
                    addresses: Object.values(usdcCommonAccounts).filter((key) => key !== undefined),
                });

                await expectIxOk(connection, [extendIx], [payer], {
                    confirmOptions: { commitment: "finalized" },
                });

                tokenRouterLkupTable = lookupTable;
            });
        });

        describe("Peer Registration", () => {
            it("Add Peer As Owner", async () => {
                const gasPrice = 690000;
                const gasTokenPrice = new anchor.BN(10000);
                const baseFee = 100000;
                const maxGasDropoff = new anchor.BN(10000);
                const margin = 10000; // 1%

                const ix = await swapLayer.addPeerIx(
                    {
                        ownerOrAssistant: payer.publicKey,
                        payer: payer.publicKey,
                    },
                    {
                        chain: foreignChain,
                        address: foreignSwapLayerAddress,
                        relayParams: {
                            baseFee,
                            nativeTokenPrice: gasTokenPrice,
                            maxGasDropoff,
                            gasDropoffMargin: margin,
                            executionParams: {
                                evm: {
                                    gasPrice,
                                    gasPriceMargin: margin,
                                },
                            },
                        },
                    },
                );

                await expectIxOk(connection, [ix], [payer]);
            });
        });
    });

    describe("Business Logic", function () {
        let testCctpNonce = 2n ** 64n - 20n * 6400n;

        let wormholeSequence = 2000n;
        describe("USDC Transfer (Relay)", function () {
            it("Self Redeem Fill", async function () {
                const result = await createAndRedeemCctpFillForTest(
                    connection,
                    tokenRouter,
                    swapLayer,
                    tokenRouterLkupTable,
                    payer,
                    testCctpNonce++,
                    foreignChain,
                    foreignTokenRouterAddress,
                    foreignSwapLayerAddress,
                    wormholeSequence,
                    Buffer.from(
                        "010000000000000000000000006ca6d1e2d5347bfab1d91e883f1915560e09129d02000000000000000f424000",
                        "hex",
                    ),
                );
                const { vaa, message } = result!;

                const vaaAccount = await VaaAccount.fetch(connection, vaa);
                const preparedFill = tokenRouter.preparedFillAddress(vaaAccount.digest());
                const beneficiary = Keypair.generate();

                // Balance check.
                const recipientBefore = await getUsdcAtaBalance(connection, payer.publicKey);
                const payerLamportBefore = await connection.getBalance(payer.publicKey);
                const feeRecipientBefore = await getUsdcAtaBalance(
                    connection,
                    feeRecipient.publicKey,
                );

                const transferIx = await swapLayer.completeTransferRelayIx(
                    {
                        payer: payer.publicKey,
                        beneficiary: beneficiary.publicKey,
                        preparedFill,
                        tokenRouterCustody: tokenRouter.preparedCustodyTokenAddress(preparedFill),
                        tokenRouterProgram: tokenRouter.ID,
                        recipient: payer.publicKey,
                    },
                    foreignChain,
                );

                await expectIxOk(connection, [transferIx], [payer]);

                // Balance check.
                const recipientAfter = await getUsdcAtaBalance(connection, payer.publicKey);
                const payerLamportAfter = await connection.getBalance(payer.publicKey);
                const feeRecipientAfter = await getUsdcAtaBalance(
                    connection,
                    feeRecipient.publicKey,
                );

                expect(recipientAfter).to.equal(recipientBefore + message.deposit!.header.amount);
                expect(payerLamportAfter).to.be.lessThan(payerLamportBefore);
                expect(feeRecipientAfter).to.equal(feeRecipientBefore);
            });

            it("Fill With Gas Dropoff", async function () {
                const relayerFee = 1000000n;
                const gasAmount = 690000000n;

                const result = await createAndRedeemCctpFillForTest(
                    connection,
                    tokenRouter,
                    swapLayer,
                    tokenRouterLkupTable,
                    payer,
                    testCctpNonce++,
                    foreignChain,
                    foreignTokenRouterAddress,
                    foreignSwapLayerAddress,
                    wormholeSequence,
                    Buffer.from(
                        "010000000000000000000000006ca6d1e2d5347bfab1d91e883f1915560e09129d02000A87500000000f424000",
                        "hex",
                    ),
                );
                const { vaa, message } = result!;

                const vaaAccount = await VaaAccount.fetch(connection, vaa);
                const preparedFill = tokenRouter.preparedFillAddress(vaaAccount.digest());
                const beneficiary = Keypair.generate();

                // Balance check.
                const recipientBefore = await getUsdcAtaBalance(connection, recipient.publicKey);
                const recipientLamportBefore = await connection.getBalance(recipient.publicKey);
                const payerLamportBefore = await connection.getBalance(payer.publicKey);
                const feeRecipientBefore = await getUsdcAtaBalance(
                    connection,
                    feeRecipient.publicKey,
                );

                const transferIx = await swapLayer.completeTransferRelayIx(
                    {
                        payer: payer.publicKey,
                        beneficiary: beneficiary.publicKey,
                        preparedFill,
                        tokenRouterCustody: tokenRouter.preparedCustodyTokenAddress(preparedFill),
                        tokenRouterProgram: tokenRouter.ID,
                        recipient: recipient.publicKey,
                    },
                    foreignChain,
                );

                await expectIxOk(connection, [transferIx], [payer]);

                // Balance check.
                const recipientAfter = await getUsdcAtaBalance(connection, recipient.publicKey);
                const recipientLamportAfter = await connection.getBalance(recipient.publicKey);
                const payerLamportAfter = await connection.getBalance(payer.publicKey);
                const feeRecipientAfter = await getUsdcAtaBalance(
                    connection,
                    feeRecipient.publicKey,
                );

                expect(recipientAfter - recipientBefore).to.equal(
                    message.deposit!.header.amount - relayerFee,
                );
                expect(recipientLamportAfter - recipientLamportBefore).to.equal(Number(gasAmount));
                expect(payerLamportAfter).to.be.lessThan(payerLamportBefore - Number(gasAmount));
                expect(feeRecipientAfter).to.equal(feeRecipientBefore + relayerFee);
            });

            it("Fill Without Gas Dropoff", async function () {
                const relayerFee = 1000000n;
                const gasAmount = 0n;

                const result = await createAndRedeemCctpFillForTest(
                    connection,
                    tokenRouter,
                    swapLayer,
                    tokenRouterLkupTable,
                    payer,
                    testCctpNonce++,
                    foreignChain,
                    foreignTokenRouterAddress,
                    foreignSwapLayerAddress,
                    wormholeSequence,
                    Buffer.from(
                        "010000000000000000000000006ca6d1e2d5347bfab1d91e883f1915560e09129d02000000000000000f424000",
                        "hex",
                    ),
                );
                const { vaa, message } = result!;

                const vaaAccount = await VaaAccount.fetch(connection, vaa);
                const preparedFill = tokenRouter.preparedFillAddress(vaaAccount.digest());
                const beneficiary = Keypair.generate();

                // Balance check.
                const recipientBefore = await getUsdcAtaBalance(connection, recipient.publicKey);
                const recipientLamportBefore = await connection.getBalance(recipient.publicKey);
                const payerLamportBefore = await connection.getBalance(payer.publicKey);
                const feeRecipientBefore = await getUsdcAtaBalance(
                    connection,
                    feeRecipient.publicKey,
                );

                const transferIx = await swapLayer.completeTransferRelayIx(
                    {
                        payer: payer.publicKey,
                        beneficiary: beneficiary.publicKey,
                        preparedFill,
                        tokenRouterCustody: tokenRouter.preparedCustodyTokenAddress(preparedFill),
                        tokenRouterProgram: tokenRouter.ID,
                        recipient: recipient.publicKey,
                    },
                    foreignChain,
                );

                await expectIxOk(connection, [transferIx], [payer]);

                // Balance check.
                const recipientAfter = await getUsdcAtaBalance(connection, recipient.publicKey);
                const recipientLamportAfter = await connection.getBalance(recipient.publicKey);
                const payerLamportAfter = await connection.getBalance(payer.publicKey);
                const feeRecipientAfter = await getUsdcAtaBalance(
                    connection,
                    feeRecipient.publicKey,
                );

                expect(recipientAfter - recipientBefore).to.equal(
                    message.deposit!.header.amount - relayerFee,
                );
                expect(recipientLamportAfter - recipientLamportBefore).to.equal(Number(gasAmount));
                expect(payerLamportAfter).to.be.lessThan(payerLamportBefore - Number(gasAmount));
                expect(feeRecipientAfter).to.equal(feeRecipientBefore + relayerFee);
            });
        });

        describe("USDC Transfer (Direct)", function () {
            it("Redeem Fill (Recipient Not Payer)", async function () {
                const result = await createAndRedeemCctpFillForTest(
                    connection,
                    tokenRouter,
                    swapLayer,
                    tokenRouterLkupTable,
                    payer,
                    testCctpNonce++,
                    foreignChain,
                    foreignTokenRouterAddress,
                    foreignSwapLayerAddress,
                    wormholeSequence,
                    encodeDirectUsdcTransfer(recipient.publicKey),
                );
                const { vaa, message } = result!;

                const vaaAccount = await VaaAccount.fetch(connection, vaa);
                const preparedFill = tokenRouter.preparedFillAddress(vaaAccount.digest());
                const beneficiary = Keypair.generate();

                // Balance check.
                const recipientBefore = await getUsdcAtaBalance(connection, recipient.publicKey);
                const beneficiaryBefore = await connection.getBalance(beneficiary.publicKey);

                const transferIx = await swapLayer.completeTransferDirectIx(
                    {
                        payer: payer.publicKey,
                        beneficiary: beneficiary.publicKey,
                        preparedFill,
                        tokenRouterCustody: tokenRouter.preparedCustodyTokenAddress(preparedFill),
                        tokenRouterProgram: tokenRouter.ID,
                        recipient: recipient.publicKey,
                    },
                    foreignChain,
                );

                await expectIxOk(connection, [transferIx], [payer]);

                // Balance check.
                const recipientAfter = await getUsdcAtaBalance(connection, recipient.publicKey);
                const beneficiaryAfter = await connection.getBalance(beneficiary.publicKey);

                expect(recipientAfter).to.equal(recipientBefore + message.deposit!.header.amount);
                expect(beneficiaryAfter).to.be.greaterThan(beneficiaryBefore);
            });

            it("Redeem Fill (Recipient Is Payer)", async function () {
                const result = await createAndRedeemCctpFillForTest(
                    connection,
                    tokenRouter,
                    swapLayer,
                    tokenRouterLkupTable,
                    payer,
                    testCctpNonce++,
                    foreignChain,
                    foreignTokenRouterAddress,
                    foreignSwapLayerAddress,
                    wormholeSequence,
                    encodeDirectUsdcTransfer(payer.publicKey),
                );
                const { vaa, message } = result!;

                const vaaAccount = await VaaAccount.fetch(connection, vaa);
                const preparedFill = tokenRouter.preparedFillAddress(vaaAccount.digest());
                const beneficiary = Keypair.generate();

                // Balance check.
                const recipientBefore = await getUsdcAtaBalance(connection, payer.publicKey);
                const beneficiaryBefore = await connection.getBalance(beneficiary.publicKey);

                const transferIx = await swapLayer.completeTransferDirectIx(
                    {
                        payer: payer.publicKey,
                        beneficiary: beneficiary.publicKey,
                        preparedFill,
                        tokenRouterCustody: tokenRouter.preparedCustodyTokenAddress(preparedFill),
                        tokenRouterProgram: tokenRouter.ID,
                    },
                    foreignChain,
                );

                await expectIxOk(connection, [transferIx], [payer]);

                // Balance check.
                const recipientAfter = await getUsdcAtaBalance(connection, payer.publicKey);
                const beneficiaryAfter = await connection.getBalance(beneficiary.publicKey);

                expect(recipientAfter).to.equal(recipientBefore + message.deposit!.header.amount);
                expect(beneficiaryAfter).to.be.greaterThan(beneficiaryBefore);
            });
        });

        describe("Jupiter V6 Swap", function () {
            // TODO

            before("Not Paused", async function () {
                const custodian = await tokenRouter.fetchCustodian();
                expect(custodian.paused).is.false;
            });
        });
    });
});

async function createAndRedeemCctpFillForTest(
    connection: Connection,
    tokenRouter: tokenRouterSdk.TokenRouterProgram,
    swapLayer: SwapLayerProgram,
    tokenRouterLkupTable: PublicKey,
    payer: Keypair,
    cctpNonce: bigint,
    foreignChain: number,
    foreignEndpointAddress: number[],
    orderSender: number[],
    wormholeSequence: bigint,
    redeemerMessage: Buffer,
): Promise<void | { vaa: PublicKey; message: LiquidityLayerMessage }> {
    const encodedMintRecipient = Array.from(tokenRouter.cctpMintRecipientAddress().toBuffer());
    const sourceCctpDomain = 0;
    const amount = 6900000000n;
    const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
    const redeemer = swapLayer.custodianAddress();

    // Concoct a Circle message.
    const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
        await craftCctpTokenBurnMessage(
            tokenRouter,
            sourceCctpDomain,
            cctpNonce,
            encodedMintRecipient,
            amount,
            burnSource,
        );

    const message = new LiquidityLayerMessage({
        deposit: new LiquidityLayerDeposit(
            {
                tokenAddress: burnMessage.burnTokenAddress,
                amount,
                sourceCctpDomain,
                destinationCctpDomain,
                cctpNonce,
                burnSource,
                mintRecipient: encodedMintRecipient,
            },
            {
                fill: {
                    sourceChain: foreignChain as wormholeSdk.ChainId,
                    orderSender,
                    redeemer: Array.from(redeemer.toBuffer()),
                    redeemerMessage: redeemerMessage,
                },
            },
        ),
    });

    const vaa = await postLiquidityLayerVaa(
        connection,
        payer,
        MOCK_GUARDIANS,
        foreignEndpointAddress,
        wormholeSequence++,
        message,
        { sourceChain: "ethereum" },
    );

    const ix = await tokenRouter.redeemCctpFillIx(
        {
            payer: payer.publicKey,
            vaa,
        },
        {
            encodedCctpMessage,
            cctpAttestation,
        },
    );

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 300_000,
    });

    const { value: lookupTableAccount } = await connection.getAddressLookupTable(
        tokenRouterLkupTable,
    );

    await expectIxOk(connection, [computeIx, ix], [payer], {
        addressLookupTableAccounts: [lookupTableAccount!],
    });

    return { vaa, message };
}

async function craftCctpTokenBurnMessage(
    tokenRouter: tokenRouterSdk.TokenRouterProgram,
    sourceCctpDomain: number,
    cctpNonce: bigint,
    encodedMintRecipient: number[],
    amount: bigint,
    burnSource: number[],
    overrides: { destinationCctpDomain?: number } = {},
) {
    const { destinationCctpDomain: inputDestinationCctpDomain } = overrides;

    const messageTransmitterProgram = tokenRouter.messageTransmitterProgram();
    const { version, localDomain } = await messageTransmitterProgram.fetchMessageTransmitterConfig(
        messageTransmitterProgram.messageTransmitterConfigAddress(),
    );
    const destinationCctpDomain = inputDestinationCctpDomain ?? localDomain;

    const tokenMessengerMinterProgram = tokenRouter.tokenMessengerMinterProgram();
    const { tokenMessenger: sourceTokenMessenger } =
        await tokenMessengerMinterProgram.fetchRemoteTokenMessenger(
            tokenMessengerMinterProgram.remoteTokenMessengerAddress(sourceCctpDomain),
        );

    const burnMessage = new CctpTokenBurnMessage(
        {
            version,
            sourceDomain: sourceCctpDomain,
            destinationDomain: destinationCctpDomain,
            nonce: cctpNonce,
            sender: sourceTokenMessenger,
            recipient: Array.from(tokenMessengerMinterProgram.ID.toBuffer()), // targetTokenMessenger
            targetCaller: Array.from(tokenRouter.custodianAddress().toBuffer()), // targetCaller
        },
        0,
        Array.from(wormholeSdk.tryNativeToUint8Array(ETHEREUM_USDC_ADDRESS, "ethereum")), // sourceTokenAddress
        encodedMintRecipient,
        amount,
        burnSource,
    );

    const encodedCctpMessage = burnMessage.encode();
    const cctpAttestation = new CircleAttester().createAttestation(encodedCctpMessage);

    return {
        destinationCctpDomain,
        burnMessage,
        encodedCctpMessage,
        cctpAttestation,
    };
}

function encodeDirectUsdcTransfer(recipient: PublicKey): Buffer {
    let buf = Buffer.alloc(35);

    // Version
    buf.writeUInt8(1, 0);

    // 32 byte address.
    Buffer.from(recipient.toBuffer().toString("hex"), "hex").copy(buf, 1);

    // Redeem mode.
    buf.writeUInt8(0, 33);

    // USDC Token Type
    buf.writeUInt8(0, 34);

    return buf;
}
