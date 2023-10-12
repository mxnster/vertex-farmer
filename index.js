import { createVertexClient, getExpirationTimestamp, getOrderNonce } from '@vertex-protocol/client';
import { toPrintableObject, nowInSeconds, toFixedPoint } from '@vertex-protocol/utils';
import { ethers } from 'ethers';
import { config } from "./config.js";

const products = {
    2: {
        name: "BTC-PERP",
        decimals: 18,
        digits: 3
    },
    4: {
        name: "ETH-PERP",
        decimals: 18,
        digits: 2
    }
}

const provider = new ethers.JsonRpcProvider(config.rpc);
const signer = new ethers.Wallet(config.privateKey, provider);
const vertexClient = await createVertexClient('mainnet', { signerOrProvider: signer });

const generateRandomAmount = (min, max) => Math.random() * (max - min) + min;
const getRandomItem = arr => arr[(Math.floor(Math.random() * arr.length))]
const timeout = (msFrom, msTo = msFrom) => new Promise(res => setTimeout(res, generateRandomAmount(msFrom * 1000, msTo * 1000)));
const getRandomSide = () =>  Math.round(generateRandomAmount(0, 1)) === 0 ? "short": "long"
const prettyPrintJson = json => console.log(JSON.stringify(toPrintableObject(json), null, 2))

async function getUsdcBalance() {
    const res = await vertexClient.subaccount.getEngineSubaccountSummary({
        subaccountOwner: signer.address,
        subaccountName: 'default'
    })

    return (res.health.initial.health / 10 ** 18).toFixed(2)
}

async function getBestPair() {
    let res = await vertexClient.context.indexerClient.getSubaccountRewards({ address: signer.address.toLowerCase() })
    let btcRatio = +res.epochs[0].globalRewards.find(e => e.productId === 2).rewardCoefficient;
    let ethRatio = +res.epochs[0].globalRewards.find(e => e.productId === 4).rewardCoefficient;
    console.log(`Reward ratio: BTC = ${btcRatio}, ETH = ${ethRatio}`)

    return res.epochs[0].globalRewards.sort((a, b) => b.rewardCoefficient - a.rewardCoefficient)[0].productId
}

async function getMaxOrderSize(productId, side, price) {
    const slippage = 0.005;
    const multiplier = side === 'long' ? 1 + slippage : 1 - slippage;

    return await vertexClient.market.getMaxOrderSize({
        productId: productId,
        side: side,
        price: +(price * multiplier).toFixed(0),
        subaccountOwner: signer.address,
        subaccountName: 'default',
        spotLeverage: null
    })
}

async function placeOrder(productId, amount, price) {
    const slippage = 0.005;
    const multiplier = amount > 0 ? 1 + slippage : 1 - slippage;

    try {
        return await vertexClient.market.placeOrder({
            productId: productId,
            order: {
                subaccountName: "default",
                expiration: getExpirationTimestamp({ type: "default", expirationTime: nowInSeconds() + 60 }).toString(),
                price: +(price * multiplier).toFixed(0),
                amount: toFixedPoint(amount, products[productId].decimals),
                nonce: getOrderNonce()
            }, spotLeverage: null
        })
    } catch (e) {
        console.log(e?.error || e)
        return e
    }
}

async function recheckOrders(productId) {
    let orders = await vertexClient.context.indexerClient.getMatchEvents({
        subaccount: {
            subaccountOwner: signer.address, subaccountName: 'default'
        }, productIds: [productId], limit: 10
    })

    if (+orders[0]?.postBalances?.base?.amount !== 0 && orders.length > 0) {
        console.log(`Need to force close`)
        let price = await vertexClient.perp.getPerpPrices({ productId })
        let priceFormatted = (Number(price.indexPrice).toFixed(0))
        let isClosed = await placeOrder(productId, -orders[0].postBalances.base.amount / 10 ** products[productId].decimals, priceFormatted, false)
        console.log(`Force close: ${isClosed.status}`)
        if (isClosed.status !== 'success') {
            await timeout(10000)
            return await recheckOrders(productId)
        }
        await timeout(5000)
    }
}

async function getProductData(productId) {
    let data = await vertexClient.market.getAllMarkets()
    return data.find(e => e.productId === productId);
}

async function openClosePosition() {
    let productId = config.pair.length === 1 && config.pair[0] === 0 ? await getBestPair() : getRandomItem(config.pair);
    let productData = await getProductData(productId);
    let price = await vertexClient.perp.getPerpPrices({ productId })
    let priceFormatted = (Number(price.indexPrice).toFixed(0))
    let side = getRandomSide()
    let minSize = productData.minSize;
    let maxSize = await getMaxOrderSize(productId, side, priceFormatted)
    let sideMultiplier = side === 'long' ? 1 : -1;
    let randomPercentOfBalance = (generateRandomAmount(config.percent.from, config.percent.to) / 100)
    let amount = maxSize * randomPercentOfBalance * sideMultiplier;
    let amountReadable = (amount / (10 ** products[productId].decimals)).toFixed(products[productId].digits)

    if (Math.abs(amount) >= Math.abs(+minSize)) {
        let isOpened = await placeOrder(productId, amountReadable, priceFormatted);
        console.log(`Open ${side} ${Math.abs(Number(amountReadable))} ${products[productId].name} [price: ${priceFormatted}$] [${(randomPercentOfBalance * 100).toFixed(0)}%]: ${isOpened.status}`)

        if (isOpened.status === 'success') {
            await timeout(config.pause.beforeClose.from, config.pause.beforeClose.to)
            let price = await vertexClient.perp.getPerpPrices({ productId })
            let priceFormatted = (Number(price.indexPrice).toFixed(0))
            let isClosed = await placeOrder(productId, -amountReadable, priceFormatted, false)
            console.log(`Close: ${isClosed.status}`)
        }
    } else console.log(`Amount is lower than minSize`)
}


(async () => {
    let balance = await getUsdcBalance();
    await recheckOrders(2)
    await recheckOrders(4)

    while (balance > 0) {
        balance = await getUsdcBalance();
        console.log(`Balance: ${balance}$`)
        await openClosePosition()
        let balanceAfter = await getUsdcBalance();
        let change = balanceAfter - balance;
        let symbol = change > 0 ? '+' : '';
        console.log(`Balance change: ${symbol}${(balanceAfter - balance).toFixed(2)}$`)
        console.log('-'.repeat(60));
        await timeout(config.pause.betweenTrades.from, config.pause.betweenTrades.to)
		await recheckOrders(2)
		await recheckOrders(4)
    }
})()
