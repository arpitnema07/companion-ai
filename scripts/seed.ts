const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient();

async function main() {
  try {
    await db.category.createMany({
      data: [
        { name: "Famous People" },
        { name: "Movies & TV" },
        { name: "Musicians" },
        { name: "Games" },
        { name: "Animals" },
        { name: "Philosophy" },
        { name: "Scientist" },
      ],
    });
  } catch (error) {
    console.error("Error Seeding default categories", error);
  } finally {
    db.$disconnect();
  }
}

main();
