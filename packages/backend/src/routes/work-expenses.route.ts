import {
  confirmMatchesController,
  disconnectIntegrationController,
  getIntegrationController,
  getReconciliationController,
  resolveReviewController,
  setManualWorkExpenseController,
  synchronizationStatusController,
  triggerSynchronizationController,
  unlinkMatchController,
  updateIntegrationController,
} from '@controllers/work-expenses.controller';
import { authenticateSession } from '@middlewares/better-auth';
import { blockDemoUsers } from '@middlewares/block-demo-users';
import { checkBaseCurrencyLock } from '@middlewares/check-base-currency-lock';
import { validateEndpoint } from '@middlewares/validations';
import { Router } from 'express';

const router = Router({});

router.get(
  '/integration',
  authenticateSession,
  validateEndpoint(getIntegrationController.schema),
  getIntegrationController.handler,
);
router.put(
  '/integration',
  authenticateSession,
  blockDemoUsers,
  validateEndpoint(updateIntegrationController.schema),
  updateIntegrationController.handler,
);
router.delete(
  '/integration',
  authenticateSession,
  blockDemoUsers,
  validateEndpoint(disconnectIntegrationController.schema),
  disconnectIntegrationController.handler,
);
router.post(
  '/sync',
  authenticateSession,
  blockDemoUsers,
  validateEndpoint(triggerSynchronizationController.schema),
  triggerSynchronizationController.handler,
);
router.get(
  '/sync/status',
  authenticateSession,
  validateEndpoint(synchronizationStatusController.schema),
  synchronizationStatusController.handler,
);
router.get(
  '/reconciliation',
  authenticateSession,
  validateEndpoint(getReconciliationController.schema),
  getReconciliationController.handler,
);
router.post(
  '/matches/confirm',
  authenticateSession,
  checkBaseCurrencyLock,
  validateEndpoint(confirmMatchesController.schema),
  confirmMatchesController.handler,
);
router.delete(
  '/matches/:expenseId',
  authenticateSession,
  validateEndpoint(unlinkMatchController.schema),
  unlinkMatchController.handler,
);
router.post(
  '/reviews/:expenseId/resolve',
  authenticateSession,
  checkBaseCurrencyLock,
  validateEndpoint(resolveReviewController.schema),
  resolveReviewController.handler,
);
router.patch(
  '/transactions/:id/work-expense',
  authenticateSession,
  checkBaseCurrencyLock,
  validateEndpoint(setManualWorkExpenseController.schema),
  setManualWorkExpenseController.handler,
);

export default router;
