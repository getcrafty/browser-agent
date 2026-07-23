import type * as chromeLauncher from "chrome-launcher";
import type CDP from "chrome-remote-interface";

export interface Tab {
	targetId: string;
	url: string;
	title: string;
}

/** Restricts a Browser facade to the targets owned by one workflow node. */
export interface BrowserTargetScope {
	readonly scopeId: string;
	refresh(): Promise<void>;
	listTargetIds(): ReadonlySet<string>;
	assertOwned(targetId: string): void;
	claimCreatedTarget(targetId: string): Promise<void>;
	releaseTarget(targetId: string): void;
}

export interface Browser {
	client: CDP.Client;
	chrome: chromeLauncher.LaunchedChrome;
	Page: CDP.Client["Page"];
	Runtime: CDP.Client["Runtime"];
	DOM: CDP.Client["DOM"];
	DOMSnapshot: CDP.Client["DOMSnapshot"];
	Input: CDP.Client["Input"];
	Target: CDP.Client["Target"];
	Accessibility: CDP.Client["Accessibility"];
	currentTargetId?: string;
	port: number;
	downloadDir?: string;
	downloadRootDir?: string;
	fileWorkspaceRoot?: string;
	userDataDir?: string;
	closeTransport?: () => Promise<void>;
	onActivateTarget?: (targetId: string) => Promise<void>;
	targetScope?: BrowserTargetScope;
}

export interface BrowserViewportMetrics {
	width: number;
	height: number;
	deviceScaleFactor: number;
}

export type BrowserRemoteMouseButton =
	| "left"
	| "middle"
	| "right"
	| "back"
	| "forward";

export type BrowserRemoteInput =
	| {
			kind: "mouse";
			event: "move" | "down" | "up";
			x: number;
			y: number;
			button?: BrowserRemoteMouseButton;
			clickCount?: number;
	  }
	| {
			kind: "wheel";
			x: number;
			y: number;
			deltaX: number;
			deltaY: number;
	  }
	| {
			kind: "text";
			text: string;
	  }
	| {
			kind: "key";
			key: string;
	  }
	| {
			kind: "history";
			direction: "back" | "forward";
	  }
	| {
			kind: "reload";
	  };
