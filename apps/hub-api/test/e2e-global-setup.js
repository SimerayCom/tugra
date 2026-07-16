// e2e global setup: the registration gate closes self-service signups once the instance is initialized,
// but the shared e2e database + a single InstanceSettings row means the first `POST /auth/register` would
// otherwise gate every later register across the whole suite. Open registration once, up front, so the
// existing multi-user specs keep working. (Plain JS so no ts-jest transform is needed for globalSetup.)
const { PrismaClient } = require("@prisma/client");

module.exports = async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.instanceSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", initializedAt: new Date(), allowRegistration: true },
      update: { allowRegistration: true },
    });
  } finally {
    await prisma.$disconnect();
  }
};
