import { screen_clear } from "../menu";

export const sell_token = async () => {
    screen_clear();
    console.log("Sell Token");
    console.log("This will sell the token when it is listed on the market");
    console.log("You can set the slippage and amount to sell");
    console.log("You can also set the pumpfun token or not");
    console.log("You can also set the contract address of the token");
    console.log("You can also set the pool id of the token");
    console.log("You can also set the selling amount of the token");
}