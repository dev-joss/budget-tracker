/**
 * Static exporter template. Values are JSON-escaped by FreeMarker and no user
 * input is interpolated into the template source.
 */
export const EXPENSIFY_EXPORT_TEMPLATE = [
  '[',
  '<#assign firstExpense = true>',
  '<#assign reportStateByStatus = {',
  '  "Open":"OPEN",',
  '  "Processing":"SUBMITTED",',
  '  "Approved":"APPROVED",',
  '  "Reimbursed":"REIMBURSED",',
  '  "Archived":"ARCHIVED"',
  '}>',
  '<#list reports as report>',
  '  <#assign reportState = reportStateByStatus[report.status]!"UNSUPPORTED">',
  '  <#list report.transactionList as expense>',
  '    <#if !firstExpense>,</#if>',
  '    <#assign firstExpense = false>',
  '    {',
  '      "externalReportId":"${report.reportID?json_string}",',
  '      "reportState":"${reportState?json_string}",',
  '      "externalExpenseId":"${expense.transactionID?json_string}",',
  '      "originalAmount":${expense.amount},',
  '      "originalCurrencyCode":"${expense.currency?json_string}",',
  '      "expenseDate":"${expense.created?json_string}",',
  '      "originalMerchant":"${expense.merchant?json_string}",',
  '      "modifiedMerchant":<#if expense.modifiedMerchant?has_content>"${expense.modifiedMerchant?json_string}"<#else>null</#if>,',
  '      "isReimbursable":${expense.reimbursable?c}',
  '    }',
  '  </#list>',
  '</#list>',
  ']',
].join('\n');
