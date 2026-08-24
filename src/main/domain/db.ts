import { prisma } from '../prisma'

/**
 * A Prisma client inside a transaction. Domain functions take one of these
 * rather than reaching for the global client, so a caller decides what is
 * atomic with what — and so the same function works whether it is one step of
 * a sale or the whole of it.
 */
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Either a transaction or the client itself, for reads that need neither. */
export type DbClient = TxClient | typeof prisma
