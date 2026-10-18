import { type NextRequest, NextResponse } from "next/server";
import { allowsLocalWebRequest } from "@/lib/local-web-access";

export async function proxy(request: NextRequest) {
	if (process.env.OPENCUT_MAC_STATE && !allowsLocalWebRequest(request)) {
		return new NextResponse("Local editor access denied", {
			status: 403,
			headers: { "Cache-Control": "no-store" },
		});
	}
	return NextResponse.next();
}

export const config = { matcher: ["/:path*"] };
