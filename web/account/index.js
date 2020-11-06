import { ERC20_ABI, GOVERNANCE_ABI } from '../common/constants.js';
import { formatObject, wrapListener } from '../common/utils.js';
import { LockFlow, WithdrawFlow, DepositFlow, RagequitFlow } from '../common/flows.js';
import { getProviders, getSigner } from '../common/tx.js';
import { STRDL_ADDRESS } from '../config.js'

async function getStats () {
  const signer = await getSigner();
  const { habitat, rootProvider } = await getProviders();
  const bridge = habitat.connect(rootProvider);
  const signerAddress = await signer.getAddress();
  const { delegateKey, shares, exists, highestIndexYesVote } = await habitat.members(signerAddress);
  const tokenAddress = await habitat.approvedToken();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, rootProvider);
  const decimals = await token.decimals();
  const balanceL1 = ethers.utils.formatUnits(await token.balanceOf(signerAddress), decimals);
  const tokenSymbol = await token.symbol();

  // TODO: inform the user about pending exits
  const availableForExit = ethers.utils.formatUnits(await bridge.getERC20Exit(tokenAddress, signerAddress), decimals);

  return {
    'Available for voting': `${ethers.utils.formatUnits(shares, decimals)} ${tokenSymbol}`,
    'Pending for Withdrawal': `${availableForExit} ${tokenSymbol}`,
    'Balance on Layer 1': `${balanceL1} ${tokenSymbol}`,
  };
}

async function getStrudelStats () {
  const signer = await getSigner();
  const { habitat, rootProvider } = await getProviders();
  const tokenAddress = await habitat.approvedToken();
  const token = new ethers.Contract(tokenAddress, GOVERNANCE_ABI, rootProvider);
  const decimals = await token.decimals();
  const signerAddress = await signer.getAddress();
  const strdlToken = new ethers.Contract(STRDL_ADDRESS, ERC20_ABI, rootProvider);
  const strdlDecimals = await strdlToken.decimals();
  const strdlBalanceL1 = ethers.utils.formatUnits(await strdlToken.balanceOf(signerAddress), decimals);
  const strdlTokenSymbol = await strdlToken.symbol();

  const [endBlock, lockTotal, mintTotal] = await token.getLock(signerAddress)

  return {
    'Amount Locked': `${ethers.utils.formatUnits(lockTotal, strdlDecimals)} ${strdlTokenSymbol}`,
    'Lock expiration': `${endBlock.toString()}`,
    'Free Balance': `${strdlBalanceL1} ${strdlTokenSymbol}`,
  };
}

async function render () {
  if (!window.ethereum) {
    const btn = document.createElement('button');
    btn.innerText = 'Connect Wallet';
    btn.addEventListener(
      'click',
      async function () {
        try {
          if (!window.ethereum) {
            throw new Error('No Ethereum Wallet detected');
            return;
          }

          await render();
          btn.remove();
        } catch (e) {
          window.alert(e.toString());
        }
      },
      false
    );
    document.querySelector('.wallet').appendChild(btn);
    return;
  }

  // stats
  {
    const container = document.querySelector('.wallet');
    const stats = await getStats();
    const statContainer = formatObject(stats);

    statContainer.className = 'grid2 stats';
    container.appendChild(statContainer);
  }

  {
    const container = document.querySelector('.strudel');
    const stats = await getStrudelStats();
    const strudelContainer = formatObject(stats);

    strudelContainer.className = 'grid2 stats';
    container.appendChild(strudelContainer);

  }
  // interactive stuff
  // L1
  {
    wrapListener('button#lock', (evt) => new LockFlow(evt.target));
    // deposit
    wrapListener('button#deposit', (evt) => new DepositFlow(evt.target));
    // withdraw
    wrapListener('button#withdraw', (evt) => new WithdrawFlow(evt.target));
  }

  // L2
  {
    // ragequit
    wrapListener('button#exit', (evt) => new RagequitFlow(evt.target));
    // TODO: setDelegateKey...
  }

  {
    // TODO: list of proposals by this member and/or the delegate
    /*
    const myProposals = document.querySelector('.myProposals');
    const signer = await getSigner();
    const signerAddress = await signer.getAddress();
    const { habitat } = await getProviders();
    habitat.on(habitat.filters.SubmitProposal(null, signerAddress, signerAddress),
      function (proposalIndex) {
        console.log(proposalIndex);
      }
    );
    habitat.provider.resetEventsBlock(1);
    */
  }
}

window.addEventListener('DOMContentLoaded', render, false);
