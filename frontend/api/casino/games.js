module.exports = async (req, res) => {
  res.status(200).json({
    slots: { name: 'slots', displayName: 'Agent Slots', rtp: '95.0%', houseEdge: '5.0%', maxMultiplier: 290, minBet: '0.0001 ETH' },
    coinflip: { name: 'coinflip', displayName: 'Agent Coinflip', rtp: '95.0%', houseEdge: '5.0%', payout: '1.9x', minBet: '0.0001 ETH' },
    lotto: { name: 'lotto', displayName: 'Agent Lotto', rtp: '85.0%', houseEdge: '15.0%', ticketPrice: '0.001', payoutMultiplier: '85x' },
  });
};
