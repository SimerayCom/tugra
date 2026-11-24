-- Metric monitors on load average, temperature and bandwidth compare against an absolute value, not a percent.
ALTER TABLE "Monitor" ADD COLUMN "thresholdValue" DOUBLE PRECISION;
