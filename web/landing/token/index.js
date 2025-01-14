import {
  getProvider,
  getSigner,
  getErc20,
  displayFeedback,
  wrapListener,
  signPermit,
  getRoute,
  secondsToHms,
  selectOnFocus,
} from '/lib/utils.js';
import {
  ROOT_CHAIN_ID,
  TOKEN_TURNER,
  HBT,
  UNISWAP_FACTORY,
  INPUT_TOKEN,
  WETH,
  FUNDING_EPOCHS,
  FUNDING_SUPPLY,
  FUNDING_START_DATE,
  EPOCH_SECONDS,
} from '/lib/config.js';

const TOKEN_TURNER_ABI = [
  'function inflowOutflow (uint256, address) public view returns (uint128 inflow, uint128 outflow)',
  'function getCurrentEpoch () public view returns (uint256 epoch)',
  'function getDecayRateForEpoch (uint256 epoch) public view returns (uint256 rate)',
  'function getQuote (uint256 amountIn, uint256[] memory path) public view returns (uint256 inflow, uint256 outflow)',
  'function swapIn (address receiver, uint256 inputAmount, uint256[] memory swapRoute, bytes memory permitData) external payable',
  'function swapOut (address receiver, uint256 inputSellAmount, uint256 epoch, uint256[] memory swapRoute, bytes memory permitData) external',
];

let defaultProvider;
let uniswapFactory;
const FUNDING_PRICE = 25e6;
let tokenTurner;
let habitatToken;
let swapHistoryTimer = null;

async function setupTokenlist () {
  //const src = 'https://gateway.ipfs.io/ipns/tokens.uniswap.org';
  const src = './tokens.uniswap.org';
  const { tokens } = await (await fetch(src)).json();
  const datalist = document.createElement('datalist');

  for (const token of tokens) {
    if (token.chainId !== ROOT_CHAIN_ID) {
      continue;
    }

    const opt = document.createElement('option');
    opt.value = `${token.name} (${token.symbol}) ${token.address}`;
    datalist.appendChild(opt);
  }

  datalist.id = 'tokenlist';
  document.body.appendChild(datalist);
}

async function receiverAutofill (evt) {
  const signer = await getSigner();

  document.querySelector('input#receiver').value = await signer.getAddress();
}

function parseInput (ele) {
  const elements = ele.querySelectorAll('input');
  const config = {};

  let error = false;
  for (const ele of elements) {
    ele.classList.remove('error');
    if (!ele.value) {
      window.requestAnimationFrame(() => ele.classList.add('error'));
      error = true;
      continue;
    }
    config[ele.id] = ele.value;
  }

  return { config, error };
}

async function swap (evt) {
  const signer = await getSigner();
  const { config, error } = parseInput(document.querySelector('.swapbox'));

  if (error) {
    return;
  }

  const erc20 = await getToken(config.token);
  const inflow = ethers.utils.parseUnits(config.inputAmount, erc20._decimals);
  const account = await signer.getAddress();
  const balance = await erc20.balanceOf(account);

  if (balance.lt(inflow)) {
    throw new Error('not enough balance');
  }

  const route = await findInputRoute(erc20);
  let permitData = '0x';
  if (!erc20.isETH) {
    const allowance = await erc20.allowance(account, tokenTurner.address);
    if (allowance.lt(inflow)) {
      const permit = await signPermit(erc20, signer, tokenTurner.address, inflow);
      if (!permit) {
        const tx = await erc20.connect(signer).approve(tokenTurner.address, inflow);
        displayFeedback('Approve', document.querySelector('.swapbox > #feedback'), tx);
        await tx.wait();
      } else {
        permitData = permit.permitData;
      }
    }
  }

  const args = [
    config.receiver,
    inflow,
    route,
    permitData,
    { value: erc20.isETH ? inflow : '0x0' },
  ];
  const tokenTurnerSigner = tokenTurner.connect(signer);
  const estimate = await tokenTurnerSigner.estimateGas.swapIn(...args);
  // increase gaslimit in case of non-determinism regarding uniswap
  args[args.length - 1].gasLimit = estimate.add('10000');

  const tx = await tokenTurnerSigner.swapIn(...args);
  displayFeedback('Swap', document.querySelector('.swapbox > #feedback'), tx);
  const receipt = await tx.wait();
  update();
}

async function getToken (val) {
  const token = ethers.utils.getAddress(val.split(' ').pop());
  if (token.toLowerCase() === ethers.constants.AddressZero) {
    return { isETH: true, address: WETH, _decimals: 18,
      balanceOf: defaultProvider.getBalance.bind(defaultProvider),
    };
  }

  const tokenAddress = await defaultProvider.resolveName(token);
  const erc20 = await getErc20(tokenAddress);

  return erc20;
}

async function updateProgressBar () {
  const currentEpoch = Number(await tokenTurner.getCurrentEpoch());
  // xxx: hardcoded decimals
  const balance = ethers.utils.formatUnits(await habitatToken.balanceOf(TOKEN_TURNER), '10');
  const progress = 100 - ((balance / FUNDING_SUPPLY) * 100);
  const hbtAmount = FUNDING_SUPPLY - balance;

  const ele = document.querySelector('#innerbar');
  ele.style.width = `${progress}%`;

  const now = ~~(Date.now() / 1000);
  const nextEpoch = FUNDING_START_DATE + ((currentEpoch + 1) * EPOCH_SECONDS);
  const nextEpochDelta = nextEpoch - now;
  const fundingEnd = FUNDING_START_DATE + (EPOCH_SECONDS * FUNDING_EPOCHS) - now;
  const time = `${secondsToHms(nextEpochDelta)}`;
  const fundingEnds = `${secondsToHms(fundingEnd)}`;

  document.querySelector('#epochDisplayDescription').textContent =
    `Epoch: ${currentEpoch + 1} / ${FUNDING_EPOCHS} | ${hbtAmount.toLocaleString()} HBT distributed`;
  document.querySelector('#epochDisplayTime').textContent = `⏱ ${time} until next epoch and ⏱ ${fundingEnds} until funding ends.`;
}

async function findInputRoute (inputToken) {
  let route;

  if (inputToken.address !== INPUT_TOKEN) {
    // try input > DAI
    route = await getRoute(uniswapFactory, [inputToken.address, INPUT_TOKEN]);
    if (!route) {
      // try input > WETH > DAI
      route = await getRoute(uniswapFactory, [inputToken.address, WETH, WETH, INPUT_TOKEN]);
    }
  } else {
    route = [inputToken.address];
  }

  return route;
}

async function findOutputRoute (token) {
  let route;

  if (token.address.toLowerCase() === INPUT_TOKEN.toLowerCase()) {
    return [ethers.constants.AddressZero];
  }

  // find DAI > token
  route = await getRoute(uniswapFactory, [INPUT_TOKEN, token.address]);
  if (!route) {
    // try DAI > WETH > token
    route = await getRoute(uniswapFactory, [INPUT_TOKEN, WETH, WETH, token.address]);
  }

  console.log('outputRoute', route);
  return route;
}

async function onInputChange (evt) {
  const outp = document.querySelector('input#outputAmount');
  const { config } = parseInput(document.querySelector('.swapbox'));

  if (!config.token || !Number(evt.target.value)) {
    return;
  }

  const inputToken = await getToken(config.token);
  const v = evt.target.value;
  const realAmount = ethers.utils.parseUnits(v, inputToken._decimals);
  const route = await findInputRoute(inputToken);
  const { inflow, outflow } = await tokenTurner.getQuote(realAmount, route);
  // xxx: hardcoded decimals
  outp.value = ethers.utils.formatUnits(outflow, '10');
}

async function swapBack (evt) {
  const { config, error } = parseInput(evt.target.parentElement);
  if (error) {
    return;
  }

  const signer = await getSigner();
  // xxx: hardcoded decimals
  const sellAmount = ethers.utils.parseUnits(config.swapout, '10');
  const outputToken = await getToken(config.tokenout);
  const route = await findOutputRoute(outputToken);
  const { permitData } = await signPermit(habitatToken, signer, tokenTurner.address, sellAmount);
  route[0] = outputToken.isETH ? WETH : 0;
  const args = [
    await signer.getAddress(),
    sellAmount,
    config.epoch,
    route,
    permitData,
  ];
  const tokenTurnerSigner = tokenTurner.connect(signer);
  const estimate = await tokenTurnerSigner.estimateGas.swapOut(...args);
  // increase gaslimit in case of non-determinism regarding uniswap
  args.push({ gasLimit: estimate.add('10000') });

  const tx = await tokenTurnerSigner.swapOut(...args);
  displayFeedback('Swap', evt.target.parentElement.querySelector('#feedback'), tx);
  await tx.wait();
  update();
}

async function updateSwapHistory () {
  if (swapHistoryTimer !== null) {
    // swapHistoryTimer = setInterval(updateSwapHistory, 30000);
  }
  const currentEpoch = Number(await tokenTurner.getCurrentEpoch());
  const container = document.querySelector('#swapHistory');
  const length = container.children.length;

  for (let i = length; i <= currentEpoch; i++) {
    const e = document.createElement('div');
    e.classList.add('listitem');
    e.style.display = 'none';
    e.innerHTML = `
    <p class='bold' id='head'></p>
    <sep></sep>
    <label>
      Choose how many HBT you want to swap back
      <input id='swapout' type='number' min='0' required=true>
      <p id='info' class='bold small padv'></p>
      <habitat-slider></habitat-slider>
    </label>
    <label>
      Choose the token you want to receive.
      <input required=true list='tokenlist' id='tokenout' placeholder='Choose from the list or paste the token contract address'>
    </label>
    <label>
      You will receive
      <input id='outputAmount' disabled type='number' value='0'>
    </label>

    <button class='bold yellow'>Swap Back</button>
    <h6><br></h6>
    <div id='feedback' style='max-width:42ch;'></div>
    <input type='hidden' id='epoch' value='${i}'>
    `;

    const swapout = e.querySelector('input#swapout');
    const slider = e.querySelector('habitat-slider');
    slider.addEventListener('change', function (evt) {
      swapout.value = evt.target.value;
    }, false);
    swapout.addEventListener('keyup', () => {
      if (swapout.value > swapout.max) {
        swapout.value = swapout.max;
      }
      slider.setRange(0, swapout.value, swapout.total);
    });
    slider.addEventListener('release', () => onOutputChange(e), false);
    //wrapListener(e.querySelector('button#maxb'), () => {
    //  swapout.value = swapout.max;
    //});
    wrapListener(e.querySelector('button'), swapBack);
    wrapListener(e.querySelector('input#tokenout'), () => onOutputChange(e), 'keyup');
    wrapListener(swapout, () => onOutputChange(e), 'keyup');
    selectOnFocus(e);
    container.appendChild(e);
  }

  container.parentElement.querySelector('#nothingToSwap').style.visibility = 'hidden';
  const account = await (await getSigner()).getAddress();
  let nothingToSwap = true;
  for (let epoch = 0; epoch <= currentEpoch; epoch++) {
    const e = container.children[epoch];
    const decay = await tokenTurner.getDecayRateForEpoch(epoch);
    // amount in dai
    let { inflow, outflow }= await tokenTurner.inflowOutflow(epoch, account);
    // that can be swapped
    let available = inflow;
    available = available.sub(available.div(100).mul(decay));
    available = available.sub(outflow).div(FUNDING_PRICE);
    // skip if nothing is available
    if (available.lt(1)) {
      e.style.display = 'none';
      continue;
    }
    // xxx: hardcoded decimals
    const max = ethers.utils.formatUnits(inflow.div(FUNDING_PRICE), '10');
    const amount = ethers.utils.formatUnits(available, '10');
    e.querySelector('#head').textContent = `Epoch ${epoch + 1} | ${decay}% Decay`;
    e.querySelector('#info').textContent = `Maximum swappable amount due to decay: ${amount}`;
    const swapout = e.querySelector('#swapout');
    swapout.value = amount;
    swapout.max = amount;
    swapout.total = max;
    e.style.display = 'block';
    e.querySelector('habitat-slider').setRange(0, amount, max);

    nothingToSwap = false;
  }

  if (nothingToSwap) {
    container.parentElement.querySelector('#nothingToSwap').style.visibility = 'visible';
  }
  document.querySelector('#showSwapHistory').style.display = 'none';
}

async function onOutputChange (parent) {
  const { config, error } = parseInput(parent);
  if (error) {
    return;
  }
  if (!config.tokenout || config.tokenout.length < 42) {
    return;
  }

  // xxx: hardcoded decimals
  const sellAmount = ethers.utils.parseUnits(Number(config.swapout).toFixed(6), '10');
  const amount = sellAmount.mul(FUNDING_PRICE);
  const outputToken = await getToken(config.tokenout);
  const route = await findOutputRoute(outputToken);
  const { inflow, outflow } = await tokenTurner.getQuote(amount, route);
  const out = ethers.utils.formatUnits(inflow, outputToken._decimals);
  parent.querySelector('input#outputAmount').value = out;
}

async function update () {
  await updateSwapHistory();
  await updateProgressBar();
}

async function render () {
  defaultProvider = getProvider();
  uniswapFactory = new ethers.Contract(UNISWAP_FACTORY, ['function getPair(address,address) view returns(address)'], defaultProvider);
  tokenTurner = new ethers.Contract(TOKEN_TURNER, TOKEN_TURNER_ABI, defaultProvider);
  habitatToken = await getErc20(HBT);

  setupTokenlist();
  updateProgressBar();
  setInterval(updateProgressBar, 10000);

  wrapListener('button#receiverAutofill', receiverAutofill);
  wrapListener('button#swap', swap);

  wrapListener('input#inputAmount', onInputChange, 'keyup');
  selectOnFocus('.swapbox');
  wrapListener('#showSwapHistory', async (evt) => {
    await updateSwapHistory();
  });
}

window.addEventListener('DOMContentLoaded', render, false);
