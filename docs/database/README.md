# Database Visualization

The AI Trader Backend database schema can be visualized using [dbdiagram.io](https://dbdiagram.io).

The Prisma schema is the source of truth:

```text
prisma/schema.prisma
```

A generated DBML file is kept here for documentation and easy import into dbdiagram:
```
docs/database/ai-trader.dbml
```
Regenerating the DBML

After changing prisma/schema.prisma, regenerate the DBML file:
```
npm run prisma:generate
```

The DBML generator is configured in prisma/schema.prisma using prisma-dbml-generator.

The dbml file is built with prisma-dbml-generator (installed as a devDependency)

## Importing into dbdiagram.io

Open dbdiagram.io.

1. Create or open the AI Trader Backend diagram.

2. Copy the contents of:
```
docs/database/ai-trader.dbml
```
3. Paste it into the DBML editor.
4. Reorganize tables visually as needed.

## Important Notes
- Do not manually edit ai-trader.dbml.
- Update prisma/schema.prisma instead, then regenerate the DBML.
- The DBML file represents schema structure only.
- Manual dbdiagram layout changes are managed inside dbdiagram.io and may not be preserved by regenerating DBML.
- Do not connect dbdiagram directly to the production database.