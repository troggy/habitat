import { ROOT_CHAIN_ID, STRDL_ADDRESS } from '../config.js';
import { STRDL_ABI, GOVERNANCE_ABI, INTERVAL_LENGTH, MAX_INTERVAL } from './constants.js';
import { getProviders, sendTransaction } from './tx.js';
import {getPermitSignature} from './preparePermit.js';

export function stringDance (ele, str, _childs, idx, _skip) {
  if (_skip) {
    window.requestAnimationFrame(
      function ()  {
        stringDance(ele, str, _childs, idx, !_skip);
      }
    );
    return;
  }

  const len = str.length;

  if (!_childs) {
    ele.textContent = '';
    for (let i = 0; i < len; i++) {
      let c = document.createElement('span');
      let val = str[i];
      let x = '#';
      if (val === '.' || val === ' ' || val === '\n') {
        x = val;
      }
      c.textContent = x;
      ele.appendChild(c);
    }
    _childs = ele.children;
    idx = 0;
  }

  if (idx < len) {
    _childs[idx].textContent = str[idx];
    idx++;
  }

  const done = idx === len;
  if (!done) {
      window.requestAnimationFrame(
      function ()  {
        stringDance(ele, str, _childs, idx, !_skip);
      }
    );
  }
}

export class BaseFlow {
  constructor (root) {
    this.container = document.createElement('div');
    this.container.className = 'flow';

    this.errorBox = document.createElement('p');
    this.errorBox.className = 'error';
    this.container.appendChild(this.errorBox);

    this.notifyBox = document.createElement('p');
    this.container.appendChild(this.notifyBox);

    this.rangeValueC = document.createElement('p');
    this.container.appendChild(this.rangeValueC);

    this.input = document.createElement('input');
    this.input.disabled = true;
    this.input.addEventListener('keyup', this.onInput.bind(this), false);
    this.input.setAttribute('list', 'tokenlist');
    this.container.appendChild(this.input);

    this.cancelButton = document.createElement('button');
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.addEventListener('click', this.onDone.bind(this), false);
    this.container.appendChild(this.cancelButton);

    this.confirmButton = document.createElement('button');
    this.confirmButton.style.visibility = 'hidden';
    this.confirmButton.addEventListener('click', this.onConfirm.bind(this), false);
    this.container.appendChild(this.confirmButton);

    this.container.addEventListener('click', this._trap, false);

    const self = this;
    function animate () {
      self.container.style.animation = 'none';
      root.style.animation = 'none';
      root.removeEventListener('animationend', animate, false);
    }
    root.addEventListener('animationend', animate, false);
    root.style.animation = 'blink 1s';
    root.appendChild(this.container);
    this.container.parentElement.id = 'expanded';
  }

  _trap (evt) {
    evt.preventDefault();
    evt.stopImmediatePropagation();
  }

  ask (str, placeholder, callback) {
    this._inputCallback = callback;
    this.input.placeholder = placeholder;
    this.input.disabled = false;
    this.input.focus();

    stringDance(this.notifyBox, str);
  }

  onInput (evt) {
    evt.preventDefault();
    evt.stopImmediatePropagation();

    // enter
    if (evt.which === 13) {
      const str = evt.target.value.split(' - ')[0];

      evt.target.blur();
      evt.target.value = '';
      evt.target.placeholder = '';
      evt.target.disabled = true;

      this.handleCallback(this._inputCallback, str);
    }
  }

  confirm (label, str, callback) {
    this._buttonCallback = callback;
    this.confirmButton.textContent = label;
    this.confirmButton.style.visibility = 'visible';
    this.confirmButton.style.animation = 'jumpIn 1s';

    if (str) {
      stringDance(this.notifyBox, str);
    }
  }

  onConfirm (evt) {
    evt.preventDefault();
    evt.stopImmediatePropagation();

    this.confirmButton.style.animation = 'none';
    this.confirmButton.style.visibility = 'hidden';

    this.handleCallback(this._buttonCallback);
  }

  async handleCallback (callback, arg, error) {
    if (this._destroyed) {
      return;
    }

    if (!error) {
      this.errorBox.textContent = '';
    }

    const oldCallback = this.prev;
    const oldArg = this.prevArg;

    try {
      this.prev = callback;
      this.prevArg = arg;
      await callback.call(this, arg);
    } catch (e) {
      console.log(e);
      this.prev = oldCallback;
      this.prevArg = oldArg;
      this.writeError(e.message);

      // TODO: add a `retry` button instead
      //await new Promise((resolve) => setTimeout(resolve, 3000));
      //this.handleCallback(this.prev, this.prevArg, e);
    }
  }

  async runNext (callback, arg) {
    this.prev = callback;
    this.prevArg = arg;

    await this.handleCallback(callback, arg);
  }

  writeError (str) {
    stringDance(this.errorBox, str);
  }

  write (str) {
    stringDance(this.notifyBox, str);
  }

  onDone () {
    this._destroyed = true;

    const root = this.container.parentElement;
    const container = this.container;

    function animate () {
      root.style.animation = 'none';
      container.removeEventListener('animationend', animate, false);
      container.remove();
      root.id = '';
      root.style.animation = 'jumpIn 1s';
    }

    container.addEventListener('animationend', animate, false);
    container.style.animation = 'jumpIn 1s reverse';
    root.style.animation = 'blink 1s reverse';
  }

  async setupWallet () {
    this.confirm('Connect', 'Please Connect your Wallet.', this.onSetupWallet);
  }

  async onSetupWallet () {
    if (!window.ethereum) {
      throw new Error('No Ethereum Provider found.');
    }

    this.write('Connecting to wallet...');

    await window.ethereum.enable();

    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const network = await provider.getNetwork();

    if (network.chainId !== ROOT_CHAIN_ID) {
      throw new Error(`Wrong Network. Please switch to ${ethers.utils.getNetwork(ROOT_CHAIN_ID).name}.`);
    }

    const { habitat, rootProvider } = await getProviders();
    this.signer = await provider.getSigner();
    this.habitat = habitat;

    const tokenAddress = await this.habitat.approvedToken();
    this.erc20 = new ethers.Contract(tokenAddress, GOVERNANCE_ABI, rootProvider);
    this.tokenSymbol = await this.erc20.symbol();

    this.strdl = new ethers.Contract(STRDL_ADDRESS, STRDL_ABI, rootProvider);
    this.strdlTokenSymbol = await this.strdl.symbol();

    this.runNext(this.setupFlow);
  }
}

export class DepositFlow extends BaseFlow {
  constructor (root) {
    super(root);

    this.runNext(this.setupWallet);
  }

  async setupFlow () {
    this.ask(
      `How much ${this.tokenSymbol} do you want to deposit?`,
      'Deposit amount',
      this.confirmDeposit
    );
  }

  confirmDeposit (str) {
    const number = parseFloat(str);
    if (!number || number <= 0) {
      throw new Error('Invalid Amount.');
    }

    this._amount = str;
    this.confirm(
      'Confirm',
      `Tap 'Confirm' to deposit ${this._amount} ${this.tokenSymbol}.`,
      this.onConfirmDeposit
    );
  }

  async onConfirmDeposit () {
    const decimals = await this.erc20.decimals();
    const amount = ethers.utils.parseUnits(this._amount, decimals);

    this.runNext(this.deposit, amount);
  }

  async deposit (val) {
    const allowance = await this.erc20.allowance(await this.signer.getAddress(), this.habitat.address);
    const erc20 = this.erc20.connect(this.signer);

    if (allowance.lt(val)) {
      this.write('Allowance too low.\nPlease sign a transaction to increase the token allowance first.');
      let tx = await erc20.approve(this.habitat.address, val);
      this.write(`Waiting for Transaction(${tx.hash}) to be mined...`);
      await tx.wait();
    }

    this.write('Waiting for wallet...');

    const tx = await this.habitat.connect(this.signer).deposit(erc20.address, val, await this.signer.getAddress());
    this.confirm(
      'Done',
      `Deposit transaction hash: ${tx.hash}`,
      this.onDone
    );
  }
}

export class LockFlow extends BaseFlow {
  constructor (root) {
    super(root);
    this.rangeValueC.style.padding = "10px"
    this.rangeValueLeft = document.createElement('span');
    this.rangeValueC.appendChild(this.rangeValueLeft);
    this.rangeValueLeft.style.float = "left"

    this.rangeValueRight = document.createElement('span');
    this.rangeValueC.appendChild(this.rangeValueRight);
    this.rangeValueRight.style.float = "right"


    this.runNext(this.setupWallet);
  }

  calculateGSTRDL (weeks, amount) {
    const lockDuration = INTERVAL_LENGTH*Number(weeks);
    return (((MAX_INTERVAL*2-(lockDuration))*lockDuration*parseFloat(amount))/(MAX_INTERVAL*MAX_INTERVAL)).toFixed(2)
  }

  lock (amount, str, callback) {
    this._inputCallback = callback;
    this.input.disabled = false;
    this.input.type = 'range'
    this.input.min = 1
    this.input.max = 52
    this.input.value = 40
    this.input.step = 1
    this.input.focus();

    const rangeValueLeft = this.rangeValueLeft;
    const rangeValueRight = this.rangeValueRight;
    const calculateGSTRDL = this.calculateGSTRDL;

    rangeValueLeft.innerHTML = this.input.value;
    rangeValueRight.innerHTML = "g$TRDL: ~ " + calculateGSTRDL(this.input.value, amount)

    this.input.oninput = function() {
      rangeValueLeft.innerHTML = this.value;
      rangeValueRight.innerHTML = "g$TRDL: ~ " + calculateGSTRDL(this.value, amount)
    }

    stringDance(this.notifyBox, str);
  }

  async setupFlow () {
    this.ask(
      `How much ${this.strdlTokenSymbol} do you want to lock?`,
      'Lock amount',
      this.lockTime
    );
  }



  async lockTime (str) {
    const number = parseFloat(str);
    if (!number || number <= 0) {
      throw new Error('Invalid Amount.');
    }
    this._amount = str;
    this.lock(
      str,
      `For how many weeks do you want to lock?`,
      this.confirmDeposit
    );
  }

  confirmDeposit (str) {
    this._weeks = Number(str);
    this.container.removeChild(this.rangeValueC);
    this.input.type = "text";
    this.input.value = "";
    this.confirm(
      'Confirm',
      `Tap 'Confirm' to lock ${this._amount} ${this.strdlTokenSymbol} for ${this.calculateGSTRDL(this._weeks, this._amount)} g$TRDL.`,
      this.onConfirmDeposit
    );
  }

  async onConfirmDeposit () {
    const decimals = await this.strdl.decimals();
    const amount = ethers.utils.parseUnits(this._amount, decimals);

    this.runNext(this.deposit, amount);
  }

  async deposit (val){
    const signerAddress = await this.signer.getAddress();
    const allowance = await this.strdl.allowance(signerAddress, this.erc20.address);
    const strdl = this.strdl.connect(this.signer);
    const lockTime = Number(this._weeks) * INTERVAL_LENGTH;

    let tx;
    if (allowance.lt(val)) {
      this.write('Allowance too low.\nPlease allow the token spending first.');
      let {r, s, v, deadline} = await getPermitSignature(this.signer, signerAddress, strdl, {owner: signerAddress, spender: this.erc20.address, value: val}, ROOT_CHAIN_ID);
      this.write('Waiting for wallet...');
      tx = await this.erc20.connect(this.signer).lockWithPermit(val, lockTime, deadline, v, r, s, true);
    } else {
      this.write('Waiting for wallet...');
      tx = await this.erc20.connect(this.signer).lock(await this.signer.getAddress(), val, lockTime, true);
    }
    this.confirm(
      'Done',
      `Deposit transaction hash: ${tx.hash}`,
      this.onDone
    );
  }
}

export class WithdrawFlow extends BaseFlow {
  constructor (root) {
    super(root);

    this.runNext(this.setupWallet);
  }

  async setupFlow () {
    const availableForExit =
      (await this.habitat.connect(this.signer).getERC20Exit(this.erc20.address, await this.signer.getAddress())).toHexString();

    const str = ethers.utils.formatUnits(availableForExit, await this.erc20.decimals());

    if (Number(str) === 0) {
      throw new Error('Nothing to withdraw yet. It can take a while for ragequited shares to become available.');
    }

    this.confirm(
      'Confirm',
      `Tap 'Confirm' to withdraw ${str} ${this.tokenSymbol}.`,
      this.onConfirmWithdraw
    );
  }

  async onConfirmWithdraw () {
    this.runNext(this.withdraw);
  }

  async withdraw () {
    this.write('Waiting for wallet...');

    const tx = await this.habitat.connect(this.signer).withdraw(this.erc20.address, 0);
    this.confirm(
      'Done',
      `Withdraw transaction hash: ${tx.hash}.`,
      this.onDone
    );
  }
}

export class RagequitFlow extends BaseFlow {
  constructor (root) {
    super(root);

    this.runNext(this.setupWallet);
  }

  async setupFlow () {
    const member = await this.habitat.members(await this.signer.getAddress());
    const shares = ethers.utils.formatUnits(member.shares, await this.erc20.decimals());

    this.ask(
      `You have ${shares}. How much do you want to ragequit?`,
      'Deposit amount',
      this.confirmStep
    );
  }

  confirmStep (str) {
    // TODO: min/max
    const number = parseFloat(str);
    if (!number || number <= 0) {
      throw new Error('Invalid Amount.');
    }

    this.ragequitAmount = str;
    this.confirm(
      'Confirm',
      `Tap 'Confirm' to ragequit ${this.ragequitAmount} ${this.tokenSymbol}.`,
      this.onConfirmStep
    );
  }

  async onConfirmStep () {
    const decimals = await this.erc20.decimals();
    const amount = ethers.utils.parseUnits(this.ragequitAmount, decimals);

    this.runNext(this.ragequit, amount.toHexString());
  }

  async ragequit (sharesToBurn) {
    this.write('Waiting for wallet...');

    const receipt = await sendTransaction('Ragequit', { sharesToBurn });

    this.confirm(
      'Done',
      `Ragequit transaction hash: ${receipt.transactionHash}. It can take an hour before it becomes available to withdraw.`,
      this.onDone
    );
  }
}
