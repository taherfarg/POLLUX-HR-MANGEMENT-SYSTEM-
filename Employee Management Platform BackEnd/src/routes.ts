import { Router } from 'express';
import { advancesRouter } from './modules/advances/advances.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { authRouter } from './modules/auth/auth.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { departmentsRouter } from './modules/departments/departments.routes';
import { documentsRouter } from './modules/documents/documents.routes';
import { employeesRouter } from './modules/employees/employees.routes';
import { holidayCalendarsRouter } from './modules/holiday-calendars/holiday-calendars.routes';
import { leaveRouter } from './modules/leave/leave.routes';
import { legalEntitiesRouter } from './modules/legal-entities/legal-entities.routes';
import { meRouter } from './modules/me/me.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { overtimeRouter } from './modules/overtime/overtime.routes';
import { payrollRouter, payslipsRouter } from './modules/payroll/payroll.routes';
import { requestsRouter } from './modules/requests/requests.routes';
import { publicRouter, settingsRouter } from './modules/settings/settings.routes';
import { workLocationsRouter } from './modules/work-locations/work-locations.routes';
import { workSchedulesRouter } from './modules/work-schedules/work-schedules.routes';

/**
 * Single mount point for every versioned route. Adding `/api/v2` later means
 * adding a second router here, not restructuring the app.
 */
export const apiRouter: Router = Router();

apiRouter.get('/', (_req, res) => {
  res.json({
    data: {
      name: 'Pollux HR API',
      version: '2.0.0',
      endpoints: {
        auth: '/api/v1/auth',
        me: '/api/v1/me',
        employees: '/api/v1/employees',
        departments: '/api/v1/departments',
        workLocations: '/api/v1/work-locations',
        workSchedules: '/api/v1/work-schedules',
        holidayCalendars: '/api/v1/holiday-calendars',
        attendance: '/api/v1/attendance',
        overtime: '/api/v1/overtime',
        advances: '/api/v1/advances',
        payroll: '/api/v1/payroll',
        payslips: '/api/v1/payslips',
        requests: '/api/v1/requests',
        leave: '/api/v1/leave',
        documents: '/api/v1/documents',
        dashboard: '/api/v1/dashboard',
        notifications: '/api/v1/notifications',
        settings: '/api/v1/settings',
        auditLogs: '/api/v1/audit-logs',
        legalEntities: '/api/v1/legal-entities',
      },
    },
  });
});

apiRouter.use('/public', publicRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/legal-entities', legalEntitiesRouter);
apiRouter.use('/departments', departmentsRouter);
apiRouter.use('/work-locations', workLocationsRouter);
apiRouter.use('/work-schedules', workSchedulesRouter);
apiRouter.use('/holiday-calendars', holidayCalendarsRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/overtime', overtimeRouter);
apiRouter.use('/advances', advancesRouter);
apiRouter.use('/payroll', payrollRouter);
apiRouter.use('/payslips', payslipsRouter);
apiRouter.use('/requests', requestsRouter);
apiRouter.use('/leave', leaveRouter);
apiRouter.use('/documents', documentsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/audit-logs', auditRouter);
