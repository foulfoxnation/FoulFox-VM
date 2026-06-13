import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shellRouter from "./shell";
import vmRouter from "./vm";
import odysseusProxyRouter from "./odysseus-proxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shellRouter);
router.use(vmRouter);
router.use(odysseusProxyRouter);

export default router;
