import { AppFeatures } from "./types";
import React from "react";

export interface ConversationListProps {
    avatar?: boolean,
    title?: string | React.ReactNode,
    headerRight?: React.ReactNode
}
