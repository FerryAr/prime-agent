/** HTTP error with a status code; route handlers convert it to a JSON response. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function errorStatus(error: unknown): number {
	if (error instanceof HttpError) return error.status;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : 500;
}
