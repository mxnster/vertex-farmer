export const config = {
    privateKey: '',
    pair: [2, 4], // 2 - BTC, 4 - ETH
    rpc: 'https://arbitrum.llamarpc.com', // arbitrum RPC
    percent: { from: 70, to: 90 }, // position size
    pause: {
        beforeClose: { from: 10, to: 20 }, // delay in seconds
        betweenTrades: { from: 20, to: 40 } // delay in seconds
    }
}