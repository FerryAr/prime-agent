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
	return 500;
}
