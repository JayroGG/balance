'use strict';
const fields = {
  create:       ['channel', 'kind', 'direction', 'amount', 'merchant_raw', 'last4',
                 'captured_at', 'notification_hash'],
  update:       [], // captures are never edited — status moves via the pipeline/review actions
  moneyFields:  ['amount'],
  filterFields: ['status', 'channel', 'source_id'],
};
module.exports = { fields };
