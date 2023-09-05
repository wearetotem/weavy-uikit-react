import { AppFeatures } from "./types";
import React from "react";

export interface ConversationProps {
  id?: number | null,  
  showBackButton?: boolean,
  features?: AppFeatures | undefined,
  header?: boolean;
  avatarHeader?: boolean;
  details?: boolean;
}
