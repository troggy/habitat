const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const Permit = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];

const getApprovalData = async (token, approve, nonce, deadline, chainId) => {
  const name = await token.name();

  const domain = {
    name: name,
    version: "1",
    chainId: chainId,
    verifyingContract: token.address,
  };
  nonce = ethers.utils.bigNumberify(nonce);

  const message = {
    owner: approve.owner,
    spender: approve.spender,
    value: approve.value.toString(),
    nonce: nonce.toHexString(),
    deadline: deadline.toNumber(),
  };
  return JSON.stringify({
    types: {
      EIP712Domain,
      Permit,
    },
    domain,
    primaryType: "Permit",
    message,
  });
};

export const getPermitSignature = async (
  signer,
  signerAddress,
  token,
  approve,
  chainId
) => {
  const nonce = await token.nonces(signerAddress);
  let dt = new Date();
  dt.setHours(dt.getHours() + 1);
  const deadline = ethers.utils.bigNumberify(Math.floor(dt.getTime() / 1000));
  const data = await getApprovalData(
    token,
    approve,
    nonce,
    deadline,
    chainId
  );
  const sig = await signer.provider.send("eth_signTypedData_v4", [
    signerAddress,
    data,
  ]);
  const { r, s, v } = ethers.utils.splitSignature(sig);
  return { r, s, v, deadline: deadline.toNumber()};
};
